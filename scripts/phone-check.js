// A simulated phone call, end to end: the real server and models, and a simulated Plivo
// stream (test/plivo-simulator.js) that follows Plivo's documented protocol, in real time.
// The caller's test audio is sent as phone audio (8 kHz mu-law by default), so this also
// shows how the local speech-to-text does on telephone-quality speech.
//
//   npm run check:phone [-- --format audio/x-l16;rate=16000] [-- --out results/phone]
//
// It is not a live call: no Plivo account is involved, and real phone networks add their
// own delay and audio processing.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { startServer } from "../src/server.js";
import { decodeWav, encodeWav, resample } from "../src/speech/pcm.js";
import { PlivoSimulator } from "../test/plivo-simulator.js";

const { values: args } = parseArgs({
  options: {
    format: { type: "string", default: "audio/x-mulaw;rate=8000" },
    out: { type: "string" },
  },
});

const clip = async (id) => decodeWav(await readFile(new URL(`../test/audio/${id}.wav`, import.meta.url))).samples;
const manifest = JSON.parse(await readFile(new URL("../test/audio/manifest.json", import.meta.url), "utf8"));
const leadTicks = manifest.leadMs / 20;

loadEnvFile();
const config = { ...loadConfig(), port: 0 };
console.log("Loading models ...");
const server = await startServer(config, { log: (line) => console.log(`[server] ${line}`) });
for await (const token of server.providers.llm.stream([{ role: "user", content: "Hi" }])) void token;

const sim = new PlivoSimulator(`ws://127.0.0.1:${server.port}/plivo`, { contentType: args.format });
await sim.connect();
console.log(`Simulated call, ${args.format}`);

// Real-time pacing: one 20 ms tick per 20 ms.
const start = performance.now();
const tick = async () => {
  sim.tick();
  const next = start + sim.ticks * 20;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - performance.now())));
};
const played = (name) => sim.received.some((m) => m.event === "checkpoint" && m.name === name) && !sim.playback.some((e) => e.checkpoint === name);
const quiet = async (seconds) => {
  for (let i = 0; i < seconds * 50; i++) await tick();
};
const waitUntil = async (condition, seconds = 30) => {
  for (let i = 0; i < seconds * 50 && !condition(); i++) await tick();
};

// Greeting, then a question, then the long question interrupted 1.5 s into the reply.
await waitUntil(() => sim.received.some((m) => m.event === "checkpoint") && !sim.playing);
await quiet(0.5);
sim.say(await clip("01-greeting"));
await waitUntil(() => sim.callerIdle);
await waitUntil(() => played("turn-2-piece-0") && !sim.playing);
await quiet(0.5);
sim.say(await clip("02-long-question"));
await waitUntil(() => sim.callerIdle && sim.playing);
await quiet(1.5);
const interruption = sim.say(await clip("05-interruption"));
await waitUntil(() => sim.received.some((m) => m.event === "clearAudio"), 10);
const clearTick = sim.received.find((m) => m.event === "clearAudio")?.tick;
const speechToClearMs = clearTick === undefined ? null : (clearTick - (interruption.startTick + leadTicks)) * 20;
await waitUntil(() => sim.callerIdle);
await waitUntil(() => played("turn-4-piece-0") && !sim.playing);
await quiet(1);
sim.close();

const playAudio = sim.received.filter((m) => m.event === "playAudio");
const checkpoints = sim.received.filter((m) => m.event === "checkpoint");
console.log(`\nplayAudio messages ${playAudio.length} (largest payload ${Math.max(...playAudio.map((m) => m.media.payload.length))} base64 characters), checkpoints ${checkpoints.length}, format mismatches ${sim.received.filter((m) => m.event === "format_mismatch").length}`);
console.log(`Barge-in: clearAudio arrived ${speechToClearMs} ms after the caller started speaking`);

if (args.out) {
  await mkdir(args.out, { recursive: true });
  const join = (frames) => {
    const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    frames.reduce((offset, f) => (out.set(f, offset), offset + f.length), 0);
    return resample(out, sim.format.sampleRate, 16000);
  };
  const caller = join(sim.callerTrack);
  const agent = join(sim.agentTrack);
  const mix = new Int16Array(Math.max(caller.length, agent.length));
  for (let i = 0; i < mix.length; i++) mix[i] = Math.max(-32768, Math.min(32767, (caller[i] ?? 0) + (agent[i] ?? 0)));
  await writeFile(`${args.out}/call.wav`, encodeWav({ samples: mix, sampleRate: 16000 }));
  console.log(`Wrote ${args.out}/call.wav (both sides mixed, as heard on the line)`);
}
await server.close();
process.exit(speechToClearMs === null ? 1 : 0);
