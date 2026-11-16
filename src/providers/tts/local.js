// Local text-to-speech: Kokoro-82M (Apache-2.0) through sherpa-onnx, with the
// pronunciation fixes in src/speech (numbers in words, derived word forms, acronyms).
// Words that are still unknown are returned in `outOfVocabulary`, because the engine
// skips them silently.

import { KOKORO_VOICES, MODELS, modelPath } from "../../speech/models.js";
import { loadLexicon, prepareWords } from "../../speech/lexicon.js";
import { normalizeForSpeech } from "../../speech/normalize.js";
import { float32ToInt16 } from "../../speech/pcm.js";
import { loadSherpa } from "../../speech/sherpa.js";

/** @returns {Promise<import("../types.js").TTSProvider>} */
export async function localTTS({ model = "kokoro-en", voice = "af_heart", speed = 1, numThreads = 4 } = {}) {
  if (!model.startsWith("kokoro")) {
    throw new Error(`local TTS supports the Kokoro models (${Object.keys(MODELS).filter((m) => m.startsWith("kokoro")).join(", ")})`);
  }
  const speaker = speakerId(voice);
  const dir = modelPath(model);
  const lexicon = loadLexicon(`${dir}/lexicon-us-en.txt`);
  const tts = await loadSherpa().OfflineTts.createAsync({
    model: {
      kokoro: {
        model: `${dir}/${MODELS[model].files.model}`,
        voices: `${dir}/voices.bin`,
        tokens: `${dir}/tokens.txt`,
        lexicon: lexicon.files.join(","),
      },
      numThreads,
      provider: "cpu",
      debug: 0,
    },
    maxNumSentences: 1,
  });
  return {
    name: `local:${model}:${KOKORO_VOICES[speaker]}`,
    /** Turns text into what the engine will be given (exposed for tests and the README). */
    prepare: (text) => prepareWords(normalizeForSpeech(text), lexicon.has),
    async synthesize(text, { signal } = {}) {
      signal?.throwIfAborted();
      const { text: prepared, outOfVocabulary } = this.prepare(text);
      const generated = await tts.generateAsync({
        text: prepared,
        sid: speaker,
        speed,
        // Returning false stops generation (barge-in).
        onProgress: () => !signal?.aborted,
      });
      signal?.throwIfAborted();
      return { samples: float32ToInt16(generated.samples), sampleRate: generated.sampleRate, outOfVocabulary };
    },
  };
}

function speakerId(voice) {
  const id = /^\d+$/.test(String(voice)) ? Number(voice) : KOKORO_VOICES.indexOf(voice);
  if (id < 0 || id >= KOKORO_VOICES.length) {
    throw new Error(`Unknown Kokoro voice "${voice}". English voices: ${KOKORO_VOICES.join(", ")}`);
  }
  return id;
}
