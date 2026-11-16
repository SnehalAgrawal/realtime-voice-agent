// Runs the browser client end to end in the installed Google Chrome (headless), with a WAV
// file as a fake microphone, and checks what the page received: the greeting, a
// transcribed question with its reply played to the end, and a barge-in.
//
//   npm run check:browser        (needs Chrome, the models, and Ollama running)
//   npm run check:browser -- --screenshot page.png
//   npm run check:browser -- --record              also records (tab video and both voices) and checks the file
//   npm run check:browser -- --record-audio-only   the same, with screen sharing declined
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
    // Accept the "share this tab" prompt for the recording check.
    "--auto-accept-this-tab-capture",
    "--auto-select-tab-capture-source-by-title=Voice agent",
  ],
});
const recordMode = process.argv.includes("--record-audio-only") ? "audio" : process.argv.includes("--record") ? "video" : null;
let failed;
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));
  await page.goto(server.url);
  await page.click("#start");
  if (recordMode) {
    await page.waitForSelector("#record:not([disabled])");
    if (recordMode === "audio") {
      // As if screen sharing were declined.
      await page.evaluate(() => {
        navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException("declined", "NotAllowedError"));
      });
    }
    await page.click("#record");
    await page.waitForSelector("#record.recording");
  }
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
  let recordingCheck = null;
  if (recordMode) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#record")]);
    const saved = join(dir, download.suggestedFilename());
    await download.saveAs(saved);
    recordingCheck = await page.evaluate(analyseRecording);
    recordingCheck.file = download.suggestedFilename();
    console.log(`Recording: ${recordingCheck.file}, ${(recordingCheck.size / 1e6).toFixed(1)} MB, ${recordingCheck.type}, video ${recordingCheck.video}, ${recordingCheck.seconds.toFixed(1)} s of audio`);
    console.log(`  level while only the assistant spoke ${recordingCheck.assistantRms.toFixed(3)} (${recordingCheck.assistantWindow}), while only the caller spoke ${recordingCheck.callerRms.toFixed(3)} (${recordingCheck.callerWindow})`);
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
    ...(recordingCheck
      ? [
          [`the recording has ${recordMode === "video" ? "video and " : ""}audio`, recordingCheck.video === (recordMode === "video") && recordingCheck.seconds > 20],
          ["the assistant's voice is in the recording", recordingCheck.assistantRms > 0.01],
          ["the caller's voice is in the recording", recordingCheck.callerRms > 0.01],
        ]
      : []),
  ];
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  failed = checks.some(([, ok]) => !ok);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);

/**
 * Runs in the page: decodes the saved recording and measures its level while only the
 * assistant was speaking (the greeting, before the caller says anything) and while only
 * the caller was speaking (their first question, before any reply).
 */
async function analyseRecording() {
  const { blob, video, size, type } = globalThis.voiceRecording;
  const log = globalThis.voiceLog;
  const startedAt = globalThis.voiceStats.recordingStartedAt;
  const audio = await new globalThis.OfflineAudioContext(1, 1, 48000).decodeAudioData(await blob.arrayBuffer());
  const samples = audio.getChannelData(0);
  const rms = (from, to) => {
    const a = Math.max(0, Math.floor(((from - startedAt) / 1000) * audio.sampleRate));
    const b = Math.min(samples.length, Math.floor(((to - startedAt) / 1000) * audio.sampleRate));
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    return b > a ? Math.sqrt(sum / (b - a)) : 0;
  };
  const greetingStart = log.find((m) => m.type === "audio" && m.turn === 1).at;
  const greetingEnd = log.filter((m) => m.type === "played" && m.turn === 1 && m.done).at(-1).at;
  const callerStart = log.find((m) => m.type === "speech_start" && m.at > greetingEnd).at;
  const callerEnd = log.find((m) => m.type === "transcript" && m.at > callerStart).at - 700;
  const window = (a, b) => `${((a - startedAt) / 1000).toFixed(1)}–${((b - startedAt) / 1000).toFixed(1)} s`;
  return {
    video,
    size,
    type,
    seconds: audio.duration,
    assistantRms: rms(greetingStart + 300, greetingEnd - 300),
    assistantWindow: window(greetingStart + 300, greetingEnd - 300),
    callerRms: rms(callerStart, callerEnd),
    callerWindow: window(callerStart, callerEnd),
  };
}
