// Runs the browser client end to end in the installed Google Chrome (headless), with a WAV
// file as a fake microphone, and checks what the page received: the greeting, a
// transcribed question with its reply played to the end, and a barge-in.
//
//   npm run check:browser        (needs Chrome, the models, and Ollama running)
//   npm run check:browser -- --screenshot page.png
//
// Chrome reads the file from the moment the page asks for the microphone; the file has
// silence where the assistant is expected to speak. The timing of the interruption is
// fixed in the file, so it lands while the assistant is either still thinking or
// speaking; the check accepts both and reports which.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { startServer } from "../src/server.js";
import { decodeWav, encodeWav } from "../src/speech/pcm.js";

const RATE = 16000;
const audioDir = new URL("../test/audio/", import.meta.url);
const clip = async (id) => decodeWav(await readFile(new URL(`${id}.wav`, audioDir))).samples;
const silence = (seconds) => new Int16Array(Math.round(seconds * RATE));

// The fake microphone: greeting time, a question, the long question, then an interruption
// about 2 s after the long question's audio ends.
const parts = [
  silence(6),
  await clip("01-greeting"),
  silence(7),
  await clip("02-long-question"),
  silence(2),
  await clip("05-interruption"),
  silence(12),
];
const total = parts.reduce((n, p) => n + p.length, 0);
const mic = new Int16Array(total);
parts.reduce((offset, p) => (mic.set(p, offset), offset + p.length), 0);
const dir = await mkdtemp(join(tmpdir(), "voice-check-"));
const micFile = join(dir, "microphone.wav");
await writeFile(micFile, encodeWav({ samples: mic, sampleRate: RATE }));

loadEnvFile();
const config = { ...loadConfig(), port: 0 };
console.log("Loading models ...");
const server = await startServer(config, { log: (line) => console.log(`[server] ${line}`) });
// Warm the LLM so the first turn does not include loading it.
for await (const token of server.providers.llm.stream([{ role: "user", content: "Hi" }])) void token;

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${micFile}%noloop`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
let failed;
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));
  await page.goto(server.url);
  await page.click("#start");
  const seconds = total / RATE + 8;
  console.log(`Conversation running for up to ${Math.round(seconds)} s ...`);
  const deadline = Date.now() + seconds * 1000;
  let log = [];
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    log = await page.evaluate(() => globalThis.voiceLog);
    const ends = log.filter((m) => m.type === "turn_end");
    if (ends.length >= 4 && ends.at(-1).transcript?.toLowerCase().includes("stop")) break;
  }
  const statusText = await page.textContent("#status");
  const stats = await page.evaluate(() => globalThis.voiceStats);
  const screenshot = process.argv.indexOf("--screenshot");
  if (screenshot > 0) await page.screenshot({ path: process.argv[screenshot + 1], fullPage: true });
  console.log(`Microphone: ${stats.micFrames} frames sent (${((stats.micFrames * 20) / 1000).toFixed(1)} s), peak level ${stats.micPeak.toFixed(2)}`);
  const shown = await page.$$eval(".latency strong", (nodes) => nodes.map((n) => n.textContent));

  const ends = log.filter((m) => m.type === "turn_end");
  const audio = log.filter((m) => m.type === "audio");
  const played = log.filter((m) => m.type === "played" && m.done);
  const interrupted = log.filter((m) => m.type === "interrupted");
  const clears = log.filter((m) => m.type === "clear");
  console.log("\nTurns:");
  for (const e of ends) {
    const t = e.fromSpeechEnd;
    const fromSpeech = e.endpoint ? `${e.endpoint.silenceWaitMs + (t.first_audio_sent ?? NaN)} ms from end of speech to first audio` : "greeting";
    console.log(`  ${e.turn} ${e.outcome.padEnd(11)} ${JSON.stringify(e.transcript ?? "")} → ${JSON.stringify((e.reply ?? "").slice(0, 70))} (${fromSpeech})`);
  }
  for (const i of interrupted) console.log(`  barge-in on turn ${i.turn}: kept ${JSON.stringify(i.heard)}`);
  console.log(`Audio pieces received ${audio.length}, played to the end ${played.length}; latency panels shown: ${shown.join(", ")}; status "${statusText}"`);

  const checks = [
    ["the server sent ready", log.some((m) => m.type === "ready")],
    ["microphone audio was sent", stats.micFrames > 500 && stats.micPeak > 0.05],
    ["the greeting played to the end", ends.some((e) => e.turn === 1 && e.outcome === "completed" && e.fromSpeechEnd.playback_done !== undefined)],
    ["the first question was transcribed", ends.some((e) => /hear me/i.test(e.transcript ?? ""))],
    ["its reply played to the end (playback reported back)", ends.some((e) => /hear me/i.test(e.transcript ?? "") && e.outcome === "completed" && e.fromSpeechEnd.playback_done !== undefined)],
    ["the long question was interrupted", interrupted.length === 1 && ends.some((e) => /racing/i.test(e.transcript ?? "") && e.outcome === "interrupted")],
    ["the page was told to clear playback", clears.length >= 1],
    ["the interruption was answered", ends.some((e) => /stop/i.test(e.transcript ?? "") && e.outcome === "completed")],
    ["latency panels were shown", shown.length >= 2],
  ];
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  failed = checks.some(([, ok]) => !ok);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
