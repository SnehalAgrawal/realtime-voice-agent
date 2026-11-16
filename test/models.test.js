// The local speech models, end to end on the committed test audio. Skipped when the
// models have not been downloaded (npm run models), as on a fresh checkout or in CI.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { before, describe, test } from "node:test";
import { MODELS, MODELS_DIR } from "../src/speech/models.js";
import { decodeWav } from "../src/speech/pcm.js";

const available = ["silero-vad", "moonshine-base-en", "kokoro-en"].every((m) => existsSync(MODELS_DIR + MODELS[m].path));
const manifest = JSON.parse(await readFile(new URL("audio/manifest.json", import.meta.url), "utf8"));
const load = async (id) => decodeWav(await readFile(new URL(`audio/${id}.wav`, import.meta.url)));
const words = (text) => text.toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/).filter(Boolean);

describe("local speech models", { skip: available ? false : "models not downloaded (npm run models)" }, () => {
  let Endpointer;
  let stt;
  let tts;
  before(async () => {
    ({ Endpointer } = await import("../src/speech/endpointer.js"));
    const { localSTT } = await import("../src/providers/stt/local.js");
    const { localTTS } = await import("../src/providers/tts/local.js");
    [stt, tts] = await Promise.all([localSTT(), localTTS()]);
  });

  test("the endpointer finds one utterance per test file, with the pre-roll in front", async () => {
    for (const { id, speechMs } of manifest.utterances) {
      const audio = await load(id);
      const endpointer = new Endpointer({ minSilenceMs: 500, prerollMs: 300 });
      const events = endpointer.accept(audio.samples);
      const starts = events.filter((e) => e.type === "speech_start");
      const ends = events.filter((e) => e.type === "speech_end");
      assert.equal(starts.length, 1, `${id}: one start`);
      assert.equal(ends.length, 1, `${id}: one end (the file has 1.5 s of trailing silence)`);
      const [end] = ends;
      const segmentMs = ((end.endSample - end.startSample) / 16000) * 1000;
      assert.ok(Math.abs(end.decidedSample - end.endSample - 8000) <= 512, `${id}: decided after ~500 ms of silence`);
      assert.equal(end.audio.samples.length, end.endSample - Math.max(0, end.startSample - 4800), `${id}: pre-roll included`);
      assert.ok(segmentMs > speechMs * 0.6 && segmentMs < speechMs + 600, `${id}: segment ${segmentMs} ms vs speech ${speechMs} ms`);
    }
  });

  test("speech-to-text recovers most words of every test utterance", async () => {
    for (const { id, text } of manifest.utterances) {
      const audio = await load(id);
      const { text: heard } = await stt.transcribe(audio);
      const expected = words(text);
      const got = new Set(words(heard));
      const found = expected.filter((w) => got.has(w)).length;
      assert.ok(found / expected.length >= 0.75, `${id}: ${JSON.stringify(heard)} vs ${JSON.stringify(text)}`);
    }
  });

  test("text-to-speech pronounces normalised text with no unknown words", async () => {
    const prepared = tts.prepare("Our clinic opens at 9:30 and the API costs $25.50.");
    assert.deepEqual(prepared, {
      text: "Our clinic opens at nine thirty and the ay pee eye costs twenty five dollars and fifty cents.",
      outOfVocabulary: [],
    });
    const audio = await tts.synthesize("It opens at nine.");
    assert.equal(audio.sampleRate, 24000);
    const seconds = audio.samples.length / audio.sampleRate;
    assert.ok(seconds > 0.6 && seconds < 3, `${seconds} s`);
    assert.ok(Math.max(...audio.samples.map(Math.abs)) > 1000, "not silent");
  });

  test("an aborted synthesis throws instead of returning audio", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(tts.synthesize("This should not be spoken.", { signal: controller.signal }), { name: "AbortError" });
  });
});
