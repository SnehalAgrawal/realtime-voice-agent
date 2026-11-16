// Plays the caller test audio into a voice session in real time and records what happens.
//
// A simulated microphone sends 20 ms frames (the test utterances, silence in between), and
// a simulated speaker plays the replies in real time and reports progress, as the browser
// client does. The script includes a barge-in: the caller interrupts the long answer.
// Nothing is played aloud, and the assistant's audio is not fed back into the microphone
// (no echo), so this measures the pipeline, not acoustics. Every model is warmed up first
// (one short request each), as it would be on a server that is already running.
//
//   node scripts/converse.js [--out results/<name>] [--no-barge-in]
//
// Writes, under --out: turns.json (every turn's timeline) and conversation.wav (stereo:
// caller left, assistant right).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { createLLM, createSTT, createTTS } from "../src/providers/index.js";
import { VoiceSession } from "../src/session.js";
import { Endpointer } from "../src/speech/endpointer.js";
import { decodeWav, toRate } from "../src/speech/pcm.js";

const FRAME_MS = 20;
const RATE = 16000;
const FRAME = (RATE * FRAME_MS) / 1000;
const AUDIO_DIR = new URL("../test/audio/", import.meta.url);

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: `results/${new Date().toISOString().replace(/[:.]/g, "-")}` },
    "no-barge-in": { type: "boolean", default: false },
    "barge-in-after-ms": { type: "string", default: "1500" },
  },
});

/** The caller's side of the conversation. */
const SCRIPT = [
  { say: "01-greeting" },
  { say: "02-long-question", interruptWith: args["no-barge-in"] ? null : "05-interruption" },
  { say: "03-follow-up" },
  { say: "04-numbers" },
  { say: "06-goodbye" },
];

loadEnvFile();
const config = loadConfig();
const log = (...parts) => console.log(`[${(mic?.position / RATE || 0).toFixed(2).padStart(6)} s]`, ...parts);

const manifest = JSON.parse(await readFile(new URL("manifest.json", AUDIO_DIR), "utf8"));
const utterances = new Map();
for (const u of manifest.utterances) {
  utterances.set(u.id, { ...u, audio: decodeWav(await readFile(new URL(u.file, AUDIO_DIR))) });
}

console.log("Loading models ...");
const [stt, tts] = await Promise.all([createSTT(config.stt), createTTS(config.tts)]);
const llm = createLLM(config.llm);
const endpointer = new Endpointer(config.vad);
// Warm-up, so the first turn does not include loading models (Ollama loads on first use).
console.log("Warming up ...");
for await (const token of llm.stream([{ role: "system", content: config.systemPrompt }, { role: "user", content: "Hi" }])) void token;
await tts.synthesize("Hello there.");
await stt.transcribe({ samples: new Int16Array(RATE), sampleRate: RATE });
console.log(`LLM ${llm.name} | STT ${stt.name} | TTS ${tts.name} | silence ${config.vad.minSilenceMs} ms | chunking ${config.reply.chunking.mode}`);

/** The simulated microphone: queued utterances, otherwise silence; records what it sent. */
const mic = {
  position: 0,
  queue: [],
  track: [],
  say(id) {
    const { audio } = utterances.get(id);
    const startSample = this.position + this.queue.reduce((n, a) => n + a.length, 0);
    this.queue.push(audio.samples);
    return { id, startSample, speechStartSample: startSample + Math.round((manifest.leadMs / 1000) * RATE) };
  },
  frame() {
    let frame = new Int16Array(FRAME);
    if (this.queue.length) {
      const head = this.queue[0];
      frame = head.subarray(0, FRAME);
      if (head.length <= FRAME) this.queue.shift();
      else this.queue[0] = head.subarray(FRAME);
      if (frame.length < FRAME) {
        const padded = new Int16Array(FRAME);
        padded.set(frame);
        frame = padded;
      }
    }
    this.track.push(frame);
    this.position += FRAME;
    return frame;
  },
  get idle() {
    return this.queue.length === 0;
  },
};

/** The simulated speaker: plays pieces in order in real time and reports progress. */
const speaker = {
  queue: [],
  current: null,
  track: [],
  clearedAt: null,
  play(item) {
    const audio = toRate(item.audio, RATE);
    this.queue.push({ ...item, samples: audio.samples, offset: 0, startedAt: null });
  },
  clear() {
    this.queue = [];
    this.current = null;
    this.clearedAt = mic.position;
  },
  frame() {
    const out = new Int16Array(FRAME);
    let filled = 0;
    while (filled < FRAME) {
      this.current ??= this.queue.shift() ?? null;
      const piece = this.current;
      if (!piece) break;
      piece.startedAt ??= mic.position;
      const take = Math.min(FRAME - filled, piece.samples.length - piece.offset);
      out.set(piece.samples.subarray(piece.offset, piece.offset + take), filled);
      piece.offset += take;
      filled += take;
      const done = piece.offset >= piece.samples.length;
      const played = Math.round((piece.offset / RATE) * piece.audio.sampleRate);
      session.playback({ turn: piece.turn, index: piece.index, playedSamples: played, done });
      events.push({ type: "played", turn: piece.turn, index: piece.index, at: mic.position, done });
      if (done) this.current = null;
    }
    this.track.push(out);
    return filled > 0;
  },
  get playing() {
    return Boolean(this.current || this.queue.length);
  },
};

const events = [];
const turns = [];
const session = new VoiceSession({
  llm,
  stt,
  tts,
  endpointer,
  transport: speaker,
  systemPrompt: config.systemPrompt,
  reply: config.reply,
  bargeIn: config.bargeIn,
});
session.on("transcript", ({ turn, text }) => log(`turn ${turn} caller: ${JSON.stringify(text)}`));
session.on("reply_piece", ({ turn, index, text, outOfVocabulary }) =>
  log(`turn ${turn} piece ${index}: ${JSON.stringify(text)}${outOfVocabulary.length ? `  (unknown words skipped: ${outOfVocabulary.join(", ")})` : ""}`),
);
session.on("interrupted", ({ turn, heard }) => {
  events.push({ type: "interrupted", turn, at: mic.position });
  log(`turn ${turn} interrupted; kept in history: ${JSON.stringify(heard)}`);
});
session.on("stage_error", ({ turn, stage, error }) => log(`turn ${turn} ${stage} error: ${error.message}`));
session.on("turn_end", (summary) => {
  turns.push({ ...summary, endedAt: mic.position });
  const t = summary.fromSpeechEnd;
  log(`turn ${summary.turn} ${summary.outcome}: stt ${t.stt_final} ms, first token ${t.llm_first_token} ms, first audio sent ${t.first_audio_sent} ms`);
});

// Real-time loop: one microphone frame and one speaker frame every 20 ms, drift-corrected.
const start = performance.now();
let frames = 0;
const tick = async () => {
  frames++;
  session.acceptAudio(mic.frame());
  speaker.frame();
  const next = start + frames * FRAME_MS;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - performance.now())));
};

const bargeIns = [];
for (const step of SCRIPT) {
  mic.say(step.say);
  log(`caller says ${step.say}`);
  const turnsBefore = turns.length;
  if (step.interruptWith) {
    // Wait for the reply to start playing, then interrupt it.
    while (!speaker.playing) await tick();
    const playingFrom = mic.position;
    while (mic.position - playingFrom < (Number(args["barge-in-after-ms"]) / 1000) * RATE) await tick();
    speaker.clearedAt = null;
    const interruption = mic.say(step.interruptWith);
    log(`caller interrupts with ${step.interruptWith}`);
    while (speaker.clearedAt === null && mic.position - interruption.startSample < RATE * 5) await tick();
    bargeIns.push({
      interruption: step.interruptWith,
      // From the start of the caller's speech to the assistant's audio stopping.
      speechToStopMs: speaker.clearedAt === null ? null : Math.round(((speaker.clearedAt - interruption.speechStartSample) / RATE) * 1000),
    });
    log(`barge-in: audio stopped ${bargeIns.at(-1).speechToStopMs} ms after the caller started speaking`);
  }
  // Wait for the caller's audio to finish and the resulting turn (if any) to end.
  const expected = turnsBefore + (step.interruptWith ? 2 : 1);
  while (!mic.idle || turns.length < expected || session.busy || speaker.playing) await tick();
  for (let i = 0; i < (0.5 * 1000) / FRAME_MS; i++) await tick();
}

await mkdir(args.out, { recursive: true });
const interleave = (left, right) => {
  const a = concat(left);
  const b = concat(right);
  const out = Buffer.alloc(a.length * 4);
  for (let i = 0; i < a.length; i++) {
    out.writeInt16LE(a[i], i * 4);
    out.writeInt16LE(b[i] ?? 0, i * 4 + 2);
  }
  return out;
};
await writeFile(`${args.out}/conversation.wav`, stereoWav(interleave(mic.track, speaker.track)));
await writeFile(
  `${args.out}/turns.json`,
  `${JSON.stringify({ setup: setupRecord(), turns, bargeIns, history: session.messages }, null, 2)}\n`,
);
console.log(`\nWrote ${args.out}/turns.json and conversation.wav`);
process.exit(0);

function concat(frames) {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

function stereoWav(data) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function setupRecord() {
  return {
    date: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    llm: llm.name,
    stt: stt.name,
    tts: tts.name,
    vad: config.vad,
    reply: config.reply,
    bargeIn: config.bargeIn,
    llmSettings: { temperature: config.llm.temperature, seed: config.llm.seed, numCtx: config.llm.numCtx, maxTokens: config.llm.maxTokens },
  };
}
