// Regression test for the original bot's out-of-order audio.
//
// The original sent each sentence's audio as soon as its synthesis finished. A long first
// sentence followed by a short second one was therefore played second-then-first. The
// scenario below reproduced that on the original code (commit f1b77c0); see the README.

import assert from "node:assert/strict";
import { test } from "node:test";
import { speakReply } from "../src/pipeline/reply.js";
import { SentenceChunker } from "../src/pipeline/sentence-chunker.js";
import { fakeLLM, fakeTTS } from "./helpers.js";

const LONG = "Sure, I can book that appointment for you on Tuesday morning at the downtown clinic.";
const SHORT = "Anything else today?";

test("audio is delivered in the order the model wrote it, even when synthesis finishes out of order", async () => {
  const tts = fakeTTS();
  const delivered = [];
  await speakReply({
    llm: fakeLLM(`${LONG} ${SHORT}`),
    tts,
    messages: [],
    ttsConcurrency: 4,
    deliver: ({ text }) => delivered.push(text),
  });
  assert.equal(tts.maxActive, 2, "both sentences were synthesised at the same time");
  assert.deepEqual(delivered, [LONG, SHORT]);
});

test("the scenario does reorder audio when it is sent as each synthesis finishes (the original behaviour)", async () => {
  const tts = fakeTTS();
  const chunker = new SentenceChunker();
  const sent = [];
  const pending = [];
  for await (const token of fakeLLM(`${LONG} ${SHORT}`).stream([])) {
    for (const sentence of chunker.push(token)) {
      pending.push(tts.synthesize(sentence).then((audio) => sent.push(audio.text)));
    }
  }
  for (const sentence of chunker.flush()) {
    pending.push(tts.synthesize(sentence).then((audio) => sent.push(audio.text)));
  }
  await Promise.all(pending);
  assert.deepEqual(sent, [SHORT, LONG]);
});
