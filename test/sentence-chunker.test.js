import assert from "node:assert/strict";
import { test } from "node:test";
import { SentenceChunker, toSpeech } from "../src/pipeline/sentence-chunker.js";

/** Feeds text one character at a time, the worst case for boundary detection. */
function chunkByChar(text, options) {
  const chunker = new SentenceChunker(options);
  const out = [];
  for (const ch of text) out.push(...chunker.push(ch));
  return [...out, ...chunker.flush()];
}

test("splits sentences after . ! and ?", () => {
  assert.deepEqual(chunkByChar("Hello there. How are you? Great!"), [
    "Hello there.",
    "How are you?",
    "Great!",
  ]);
});

test("gives the same pieces whether text arrives in characters, words, or one block", () => {
  const text = "It costs 3.5 dollars. Visit example.com today! Done";
  const byChar = chunkByChar(text);
  const whole = new SentenceChunker();
  const byBlock = [...whole.push(text), ...whole.flush()];
  const words = new SentenceChunker();
  const byWord = [...text.match(/\S+\s*/g).flatMap((w) => words.push(w)), ...words.flush()];
  assert.deepEqual(byChar, ["It costs 3.5 dollars.", "Visit example.com today!", "Done"]);
  assert.deepEqual(byBlock, byChar);
  assert.deepEqual(byWord, byChar);
});

test("does not split after common abbreviations", () => {
  assert.deepEqual(chunkByChar("Dr. Rao sees patients at 9 a.m. on Mondays. Book now."), [
    "Dr. Rao sees patients at 9 a.m. on Mondays.",
    "Book now.",
  ]);
});

test("keeps closing quotes and brackets with their sentence", () => {
  assert.deepEqual(chunkByChar('She said "yes." (Really.) Then left.'), [
    'She said "yes."',
    "(Really.)",
    "Then left.",
  ]);
});

test("waits for the next character before confirming a boundary", () => {
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push("Version 2."), []);
  assert.deepEqual(chunker.push("5 is out. "), ["Version 2.5 is out."]);
});

test("treats line breaks as boundaries", () => {
  assert.deepEqual(chunkByChar("First line\nSecond line"), ["First line", "Second line"]);
});

test("clause mode also splits at , ; : once the piece is long enough", () => {
  assert.deepEqual(
    chunkByChar("Yes, of course. Our clinic opens at nine in the morning, and closes at six.", {
      mode: "clause",
      minClauseChars: 24,
    }),
    ["Yes, of course.", "Our clinic opens at nine in the morning,", "and closes at six."],
  );
});

test("whole mode returns the reply only when the stream ends", () => {
  const chunker = new SentenceChunker({ mode: "whole" });
  assert.deepEqual(chunker.push("One. Two. "), []);
  assert.deepEqual(chunker.flush(), ["One. Two."]);
});

test("rejects an unknown mode", () => {
  assert.throws(() => new SentenceChunker({ mode: "words" }), /Unknown chunking mode/);
});

test("toSpeech removes Markdown, bullets, links, and emoji", () => {
  assert.equal(toSpeech("**Great** news 🎉"), "Great news");
  assert.equal(toSpeech("- First item"), "First item");
  assert.equal(toSpeech("1. Step one"), "Step one");
  assert.equal(toSpeech("See [our site](https://example.com) for `hours`."), "See our site for hours.");
  assert.equal(toSpeech("## Heading"), "Heading");
  assert.equal(toSpeech("🙂"), "");
});
