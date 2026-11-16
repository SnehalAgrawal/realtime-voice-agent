// Plays the caller test audio into a voice session in real time and prints what happens
// (see scripts/lib/conversation.js for how the microphone and speaker are simulated).
//
//   npm run converse [-- --out results/<name>] [-- --no-barge-in]
//
// With --out, writes turns.json (every turn's timeline) and conversation.wav (stereo:
// caller left, assistant right).

import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { loadProviders } from "../src/server.js";
import { runConversation, warmUp } from "./lib/conversation.js";

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    "no-barge-in": { type: "boolean", default: false },
    "barge-in-after-ms": { type: "string", default: "1500" },
  },
});

loadEnvFile();
const config = loadConfig();
console.log("Loading models ...");
const providers = await loadProviders(config);
await warmUp(providers, config.systemPrompt);
const { llm, stt, tts } = providers;
console.log(`LLM ${llm.name} | STT ${stt.name} | TTS ${tts.name} | silence ${config.vad.minSilenceMs} ms | chunking ${config.reply.chunking.mode}`);

const result = await runConversation({
  config,
  providers,
  bargeIn: !args["no-barge-in"],
  bargeInAfterMs: Number(args["barge-in-after-ms"]),
  log: (line) => console.log(line),
});

if (args.out) {
  await mkdir(args.out, { recursive: true });
  await writeFile(`${args.out}/turns.json`, `${JSON.stringify({ turns: result.turns, bargeIns: result.bargeIns, history: result.history }, null, 2)}\n`);
  await writeFile(`${args.out}/conversation.wav`, stereoWav(result.tracks.caller, result.tracks.assistant));
  console.log(`\nWrote ${args.out}/turns.json and conversation.wav`);
}
process.exit(0);

function stereoWav(left, right) {
  const join = (frames) => {
    const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    frames.reduce((offset, f) => (out.set(f, offset), offset + f.length), 0);
    return out;
  };
  const a = join(left);
  const b = join(right);
  const data = Buffer.alloc(a.length * 4);
  for (let i = 0; i < a.length; i++) {
    data.writeInt16LE(a[i], i * 4);
    data.writeInt16LE(b[i] ?? 0, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(64000, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
