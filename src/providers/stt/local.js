// Local speech-to-text: Moonshine (English, MIT) through sherpa-onnx. Transcribes each
// utterance after the endpointer has cut it out; decoding runs off the main thread.

import { MODELS, modelPath } from "../../speech/models.js";
import { int16ToFloat32, toRate } from "../../speech/pcm.js";
import { loadSherpa } from "../../speech/sherpa.js";

/** @returns {Promise<import("../types.js").STTProvider>} */
export async function localSTT({ model = "moonshine-base-en", numThreads = 2 } = {}) {
  if (!model.startsWith("moonshine")) {
    throw new Error(`local STT supports the Moonshine models (${Object.keys(MODELS).filter((m) => m.startsWith("moonshine")).join(", ")})`);
  }
  const dir = modelPath(model);
  const recognizer = await loadSherpa().OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      moonshine: { encoder: `${dir}/encoder_model.ort`, mergedDecoder: `${dir}/decoder_model_merged.ort` },
      tokens: `${dir}/tokens.txt`,
      numThreads,
      provider: "cpu",
      debug: 0,
    },
  });
  return {
    name: `local:${model}`,
    async transcribe(audio, { signal } = {}) {
      const { samples, sampleRate } = toRate(audio, 16000);
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: int16ToFloat32(samples), sampleRate });
      await recognizer.decodeAsync(stream);
      signal?.throwIfAborted();
      return { text: recognizer.getResult(stream).text.trim() };
    },
  };
}
