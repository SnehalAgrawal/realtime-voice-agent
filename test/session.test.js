import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { VoiceSession, heardText } from "../src/session.js";
import { fakeLLM, sleep } from "./helpers.js";

const REPLY = "Our clinic opens at nine. It closes at six. We are closed on Sundays.";

/** A TTS whose audio length is 1,000 samples per word, synthesised quickly. */
function wordTTS() {
  return {
    name: "words",
    async synthesize(text) {
      await sleep(2);
      return { samples: new Int16Array(text.split(/\s+/).length * 1000), sampleRate: 16000 };
    },
  };
}

/**
 * Plays pieces one after another in simulated time (1,000 samples per `msPerKSample`),
 * reporting progress every tick, as the browser client does.
 */
function simulatedTransport({ msPerKSample = 4 } = {}) {
  const transport = {
    queue: [],
    played: [],
    clears: 0,
    session: null,
    playing: null,
    play(item) {
      transport.queue.push(item);
      if (!transport.playing) transport.next();
    },
    clear() {
      transport.clears++;
      transport.queue = [];
      if (transport.playing) transport.playing.stopped = true;
      transport.playing = null;
    },
    async next() {
      const item = transport.queue.shift();
      if (!item) return;
      const state = { item, stopped: false };
      transport.playing = state;
      const total = item.audio.samples.length;
      for (let played = 0; played < total && !state.stopped; ) {
        await sleep(msPerKSample);
        if (state.stopped) return;
        played = Math.min(total, played + 1000);
        transport.session.playback({ turn: item.turn, index: item.index, playedSamples: played, done: played === total });
      }
      transport.played.push(item.text);
      transport.playing = null;
      transport.next();
    },
  };
  return transport;
}

/** An endpointer whose events the test supplies. */
function scriptedEndpointer() {
  return {
    sampleRate: 16000,
    pending: [],
    accept() {
      return this.pending.splice(0);
    },
  };
}

const utterance = (seconds = 1) => ({
  type: "speech_end",
  audio: { samples: new Int16Array(16000 * seconds), sampleRate: 16000 },
  startSample: 16000,
  endSample: 16000 * (1 + seconds),
  decidedSample: 16000 * (1 + seconds) + 8000,
});

function setup({ transcript = "When are you open?", reply = REPLY, bargeIn = true, llmDelayMs = 2 } = {}) {
  const endpointer = scriptedEndpointer();
  const transport = simulatedTransport();
  const llm = fakeLLM(reply, { delayMs: llmDelayMs });
  const stt = { name: "fake", calls: 0, async transcribe() { this.calls++; await sleep(2); return { text: transcript }; } };
  const session = new VoiceSession({ llm, stt, tts: wordTTS(), endpointer, transport, systemPrompt: "Be brief.", bargeIn });
  transport.session = session;
  const say = (...events) => {
    endpointer.pending.push(...events);
    session.acceptAudio(new Int16Array(0));
  };
  return { session, transport, llm, stt, say };
}

test("a turn: transcript, reply played in order, history, and a full timeline", async () => {
  const { session, transport, say } = setup();
  const ended = once(session, "turn_end");
  say({ type: "speech_start", sample: 20000 }, utterance());
  const [summary] = await ended;
  assert.equal(summary.outcome, "completed");
  assert.deepEqual(transport.played, ["Our clinic opens at nine.", "It closes at six.", "We are closed on Sundays."]);
  assert.deepEqual(session.messages.slice(1), [
    { role: "user", content: "When are you open?" },
    { role: "assistant", content: REPLY },
  ]);
  assert.deepEqual(Object.keys(summary.fromSpeechEnd), [
    "speech_end", "stt_final", "llm_first_token", "first_chunk", "first_audio", "first_audio_sent", "llm_done", "playback_done",
  ]);
  assert.deepEqual(summary.endpoint, { speechMs: 1000, silenceWaitMs: 500, startDetectMs: 250 });
});

test("barge-in during playback stops it and keeps only what was heard", async () => {
  const { session, transport, say } = setup();
  const interrupted = once(session, "interrupted");
  say({ type: "speech_start", sample: 0 }, utterance());
  // Wait until the second sentence is part-way through playback.
  while (!(transport.playing?.item.index === 1 && session.busy)) await sleep(1);
  await sleep(10);
  say({ type: "speech_start", sample: 0 });
  const [event] = await interrupted;
  assert.equal(transport.clears, 1);
  assert.equal(session.busy, false);
  assert.match(event.heard, /^Our clinic opens at nine\. It( closes( at)?)?$/);
  assert.deepEqual(transport.played, ["Our clinic opens at nine."]);
  const assistant = session.messages.at(-1);
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, event.heard);
  assert.ok(!assistant.content.includes("Sundays"));
});

test("barge-in before any audio leaves no assistant message, and the next turn proceeds", async () => {
  const { session, transport, say, llm } = setup({ llmDelayMs: 20 });
  const first = once(session, "turn_end");
  say({ type: "speech_start", sample: 0 }, utterance());
  await once(session, "transcript");
  say({ type: "speech_start", sample: 0 });
  const [summary] = await first;
  assert.equal(summary.outcome, "interrupted");
  assert.deepEqual(transport.played, []);
  assert.deepEqual(session.messages.slice(1), [{ role: "user", content: "When are you open?" }]);

  const second = once(session, "turn_end");
  say(utterance());
  assert.equal((await second)[0].outcome, "completed");
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(llm.calls[1].slice(1).map((m) => m.role), ["user", "user"]);
});

test("with barge-in off, speech during a reply is ignored and the reply plays out", async () => {
  const { session, transport, say, stt } = setup({ bargeIn: false });
  const ended = once(session, "turn_end");
  const ignored = [];
  session.on("ignored", (e) => ignored.push(e));
  say({ type: "speech_start", sample: 0 }, utterance());
  await once(session, "reply_piece");
  say({ type: "speech_start", sample: 0 }, utterance(2));
  await ended;
  assert.equal(transport.clears, 0);
  assert.equal(transport.played.length, 3);
  assert.equal(stt.calls, 1);
  assert.deepEqual(ignored, [{ reason: "assistant speaking", durationMs: 2000 }]);
});

test("an empty transcript ends the turn without calling the model", async () => {
  const { session, llm, say } = setup({ transcript: "" });
  const ended = once(session, "turn_end");
  say(utterance());
  assert.equal((await ended)[0].outcome, "no speech recognised");
  assert.equal(llm.calls.length, 0);
  assert.equal(session.messages.length, 1);
});

test("a model error is reported and the session keeps working", async () => {
  const { session, say } = setup();
  let calls = 0;
  session.llm = {
    name: "flaky",
    async *stream() {
      if (calls++ === 0) throw new Error("connection refused");
      yield "Back again.";
    },
  };
  const errors = [];
  session.on("stage_error", (e) => errors.push(`${e.stage}: ${e.error.message}`));
  const first = once(session, "turn_end");
  say(utterance());
  assert.equal((await first)[0].outcome, "error");
  const second = once(session, "turn_end");
  say(utterance());
  assert.equal((await second)[0].outcome, "completed");
  assert.deepEqual(errors, ["reply: connection refused"]);
});

test("greet() speaks a fixed greeting and records it", async () => {
  const { session, transport, llm } = setup();
  const ended = once(session, "turn_end");
  session.greet("Hi, how can I help?");
  await ended;
  assert.deepEqual(transport.played, ["Hi, how can I help?"]);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(session.messages.at(-1), { role: "assistant", content: "Hi, how can I help?" });
});

test("heardText keeps whole pieces, then a proportional share of a partly played one", () => {
  const piece = (text, played, samples = 1000) => ({ text, samples, played, done: played >= samples });
  assert.equal(heardText([piece("One two.", 1000), piece("Three four five six.", 500), piece("Seven.", 0)]), "One two. Three four");
  assert.equal(heardText([piece("One two.", 0)]), "");
  assert.equal(heardText([piece("One two.", 1000), piece("Three.", 1000)]), "One two. Three.");
});
