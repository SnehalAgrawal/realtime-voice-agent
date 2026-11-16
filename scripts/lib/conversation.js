// The scripted conversation used by `npm run converse` and the measurements.
//
// A simulated microphone sends 20 ms frames in real time (the test utterances, silence in
// between), and a simulated speaker plays the replies in real time and reports progress,
// as the browser client does. Nothing is played aloud and the assistant's audio is not fed
// back into the microphone (no echo): this measures the pipeline, not acoustics.

import { readFile } from "node:fs/promises";
import { VoiceSession } from "../../src/session.js";
import { Endpointer } from "../../src/speech/endpointer.js";
import { decodeWav, toRate } from "../../src/speech/pcm.js";

const FRAME_MS = 20;
const RATE = 16000;
const FRAME = (RATE * FRAME_MS) / 1000;
const AUDIO_DIR = new URL("../../test/audio/", import.meta.url);

/** The caller's side: five lines, and an interruption of the answer to the long question. */
export const SCRIPT = [
  { say: "01-greeting" },
  { say: "02-long-question", interruptWith: "05-interruption" },
  { say: "03-follow-up" },
  { say: "04-numbers" },
  { say: "06-goodbye" },
];

export async function loadTestAudio() {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", AUDIO_DIR), "utf8"));
  const utterances = new Map();
  for (const u of manifest.utterances) {
    utterances.set(u.id, { ...u, audio: decodeWav(await readFile(new URL(u.file, AUDIO_DIR))) });
  }
  return { manifest, utterances };
}

/** One short request to each model, as on a server that is already running. */
export async function warmUp({ llm, stt, tts }, systemPrompt) {
  for await (const token of llm.stream([{ role: "system", content: systemPrompt }, { role: "user", content: "Hi" }])) void token;
  await tts.synthesize("Hello there.");
  await stt.transcribe({ samples: new Int16Array(RATE), sampleRate: RATE });
}

/**
 * Runs the script once, in real time.
 * @param {object} options
 * @param {ReturnType<import("../../src/config.js").loadConfig>} options.config
 * @param {{ llm, stt, tts }} options.providers  already loaded and warmed up
 * @param {boolean} [options.bargeIn]  include the interruption (default true)
 * @param {number} [options.bargeInAfterMs]  how far into the reply's playback the caller interrupts
 * @param {(line: string) => void} [options.log]
 */
export async function runConversation({ config, providers, bargeIn = true, bargeInAfterMs = 1500, log = () => {} }) {
  const { manifest, utterances } = await loadTestAudio();
  const endpointer = new Endpointer(config.vad);
  const at = () => `[${(mic.position / RATE).toFixed(2).padStart(6)} s]`;
  const say = (line) => log(`${at()} ${line}`);

  const mic = {
    position: 0,
    queue: [],
    track: [],
    say(id) {
      const { audio } = utterances.get(id);
      const startSample = this.position + this.queue.reduce((n, a) => n + a.length, 0);
      this.queue.push(audio.samples);
      return { startSample, speechStartSample: startSample + Math.round((manifest.leadMs / 1000) * RATE) };
    },
    frame() {
      const frame = new Int16Array(FRAME);
      if (this.queue.length) {
        const head = this.queue[0];
        frame.set(head.subarray(0, FRAME));
        if (head.length <= FRAME) this.queue.shift();
        else this.queue[0] = head.subarray(FRAME);
      }
      this.track.push(frame);
      this.position += FRAME;
      return frame;
    },
    get idle() {
      return this.queue.length === 0;
    },
  };

  const speaker = {
    queue: [],
    current: null,
    track: [],
    clearedAt: null,
    play(item) {
      this.queue.push({ ...item, samples: toRate(item.audio, RATE).samples, offset: 0 });
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
        const take = Math.min(FRAME - filled, piece.samples.length - piece.offset);
        out.set(piece.samples.subarray(piece.offset, piece.offset + take), filled);
        piece.offset += take;
        filled += take;
        const done = piece.offset >= piece.samples.length;
        const playedSamples = Math.round((piece.offset / RATE) * piece.audio.sampleRate);
        session.playback({ turn: piece.turn, index: piece.index, playedSamples, done });
        if (done) this.current = null;
      }
      this.track.push(out);
    },
    get playing() {
      return Boolean(this.current || this.queue.length);
    },
  };

  const turns = [];
  const outOfVocabulary = [];
  const session = new VoiceSession({
    ...providers,
    endpointer,
    transport: speaker,
    systemPrompt: config.systemPrompt,
    reply: config.reply,
    bargeIn: config.bargeIn,
  });
  session.on("transcript", ({ turn, text }) => say(`turn ${turn} caller: ${JSON.stringify(text)}`));
  session.on("reply_piece", ({ turn, index, text, outOfVocabulary: oov }) => {
    if (oov.length) outOfVocabulary.push(...oov);
    say(`turn ${turn} piece ${index}: ${JSON.stringify(text)}${oov.length ? `  (unknown words: ${oov.join(", ")})` : ""}`);
  });
  session.on("interrupted", ({ turn, heard }) => say(`turn ${turn} interrupted; kept ${JSON.stringify(heard)}`));
  session.on("stage_error", ({ turn, stage, error }) => say(`turn ${turn} ${stage} error: ${error.message}`));
  session.on("turn_end", (summary) => {
    turns.push(summary);
    const t = summary.fromSpeechEnd;
    say(`turn ${summary.turn} ${summary.outcome}: first audio sent ${t.first_audio_sent ?? "-"} ms after the end-of-turn decision`);
  });

  const start = performance.now();
  let frames = 0;
  const tick = async () => {
    frames++;
    session.acceptAudio(mic.frame());
    speaker.frame();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, start + frames * FRAME_MS - performance.now())));
  };
  const idle = async (seconds) => {
    for (let i = 0; i < (seconds * 1000) / FRAME_MS; i++) await tick();
  };

  const bargeIns = [];
  for (const step of SCRIPT) {
    mic.say(step.say);
    say(`caller says ${step.say}`);
    if (step.interruptWith && bargeIn) {
      // Wait for the reply to start playing (at most 20 s), then interrupt it.
      for (let i = 0; i < 1000 && !speaker.playing; i++) await tick();
      const playingFrom = mic.position;
      while (mic.position - playingFrom < (bargeInAfterMs / 1000) * RATE) await tick();
      speaker.clearedAt = null;
      const interruption = mic.say(step.interruptWith);
      say(`caller interrupts with ${step.interruptWith}`);
      while (speaker.clearedAt === null && mic.position - interruption.startSample < RATE * 5) await tick();
      const stopped = speaker.clearedAt === null ? null : Math.round(((speaker.clearedAt - interruption.speechStartSample) / RATE) * 1000);
      bargeIns.push({ interruption: step.interruptWith, speechToStopMs: stopped });
      say(`barge-in: audio stopped ${stopped} ms after the caller started speaking`);
    }
    // and nothing has happened for a moment (at most 30 s).
    const deadline = mic.position + RATE * 30;
    while (mic.position < deadline && (!mic.idle || session.busy || speaker.playing)) await tick();
    await idle(0.5);
    while (mic.position < deadline && (session.busy || speaker.playing)) await tick();
  }

  return { manifest, turns, bargeIns, outOfVocabulary, history: session.messages, tracks: { caller: mic.track, assistant: speaker.track } };
}
