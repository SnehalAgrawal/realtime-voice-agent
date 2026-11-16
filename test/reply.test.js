import assert from "node:assert/strict";
import { test } from "node:test";
import { speakReply } from "../src/pipeline/reply.js";
import { TurnTimeline } from "../src/pipeline/timeline.js";
import { fakeLLM, fakeTTS, sleep } from "./helpers.js";

const REPLY = "Our clinic opens at nine. It closes at six. We are closed on Sundays.";

test("streams a reply into sentences, synthesises them, and records the timeline", async () => {
  const timeline = new TurnTimeline();
  timeline.mark("speech_end");
  const delivered = [];
  const result = await speakReply({
    llm: fakeLLM(REPLY),
    tts: fakeTTS(),
    messages: [{ role: "user", content: "When are you open?" }],
    timeline,
    deliver: ({ text, audio, index }) => delivered.push([index, text, audio.sampleRate]),
  });
  assert.equal(result.text, REPLY);
  assert.equal(result.aborted, false);
  assert.deepEqual(delivered, [
    [0, "Our clinic opens at nine.", 16000],
    [1, "It closes at six.", 16000],
    [2, "We are closed on Sundays.", 16000],
  ]);
  assert.ok(result.pieces.every((p) => p.delivered));
  const t = timeline.fromSpeechEnd();
  for (const stage of ["llm_first_token", "first_chunk", "first_audio", "first_audio_sent", "llm_done"]) {
    assert.ok(t[stage] >= 0, `${stage} recorded`);
  }
  assert.ok(t.llm_first_token <= t.first_chunk && t.first_chunk <= t.first_audio && t.first_audio <= t.first_audio_sent);
});

test("does not synthesise text that has nothing to say aloud", async () => {
  const spoken = [];
  const tts = fakeTTS();
  const synthesize = tts.synthesize.bind(tts);
  tts.synthesize = (text, options) => {
    spoken.push(text);
    return synthesize(text, options);
  };
  const result = await speakReply({ llm: fakeLLM("**Sure.** 🙂\nBye."), tts, messages: [], deliver: () => {} });
  assert.deepEqual(spoken, ["Sure.", "Bye."]);
  assert.deepEqual(result.pieces.map((p) => p.text), ["**Sure.**", "🙂", "Bye."]);
});

test("aborting (barge-in) stops generation and delivery, and reports what was delivered", async () => {
  const controller = new AbortController();
  const delivered = [];
  const promise = speakReply({
    llm: fakeLLM(REPLY, { delayMs: 10 }),
    tts: fakeTTS({ msPerChar: 1 }),
    messages: [],
    signal: controller.signal,
    deliver: ({ text }) => {
      delivered.push(text);
      if (delivered.length === 1) controller.abort();
    },
  });
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.deepEqual(delivered, ["Our clinic opens at nine."]);
  assert.deepEqual(
    result.pieces.filter((p) => p.delivered).map((p) => p.text),
    ["Our clinic opens at nine."],
  );
  assert.ok(!result.text.includes("Sundays"), "generation stopped early");
});

test("an abort before any audio delivers nothing", async () => {
  const controller = new AbortController();
  const delivered = [];
  setTimeout(() => controller.abort(), 15);
  const result = await speakReply({
    llm: fakeLLM(REPLY, { delayMs: 10 }),
    tts: fakeTTS({ msPerChar: 5 }),
    messages: [],
    signal: controller.signal,
    deliver: ({ text }) => delivered.push(text),
  });
  await sleep(200);
  assert.equal(result.aborted, true);
  assert.deepEqual(delivered, []);
});

test("an LLM error is raised to the caller", async () => {
  const llm = {
    name: "broken",
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("model not found");
    },
  };
  await assert.rejects(speakReply({ llm, tts: fakeTTS(), messages: [], deliver: () => {} }), /model not found/);
});

test("a synthesis error skips that sentence and is reported", async () => {
  const tts = fakeTTS();
  const synthesize = tts.synthesize.bind(tts);
  tts.synthesize = (text, options) =>
    text.startsWith("It closes") ? Promise.reject(new Error("voice unavailable")) : synthesize(text, options);
  const delivered = [];
  const errors = [];
  await speakReply({
    llm: fakeLLM(REPLY),
    tts,
    messages: [],
    deliver: ({ text }) => delivered.push(text),
    onError: (error, context) => errors.push(`${context}: ${error.message}`),
  });
  assert.deepEqual(delivered, ["Our clinic opens at nine.", "We are closed on Sundays."]);
  assert.deepEqual(errors, ["piece 1: voice unavailable"]);
});
