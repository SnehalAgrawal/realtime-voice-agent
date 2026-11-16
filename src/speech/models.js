// The local speech models: where they come from, their checksums, and their licences.
//
// Kokoro defaults to the float32 model: on an Apple M4 Pro CPU it synthesised a short
// sentence in about 450 ms with 4 threads, against about 1,000 ms for the int8 model,
// which does not speed up with more threads (exploratory runs, on battery; see the README).
// Only the English Moonshine models are MIT; the others are under a non-commercial licence.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MODELS_DIR = fileURLToPath(new URL("../../models/", import.meta.url));

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export const MODELS = {
  "silero-vad": {
    default: true,
    url: `${RELEASES}/asr-models/silero_vad.onnx`,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    sizeMB: 0.6,
    path: "silero_vad.onnx",
    licence: "MIT (Silero VAD)",
  },
  "moonshine-base-en": {
    default: true,
    url: `${RELEASES}/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`,
    sha256: "43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891",
    sizeMB: 106,
    path: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
    licence: "MIT (Moonshine, Useful Sensors)",
  },
  "moonshine-tiny-en": {
    default: false,
    url: `${RELEASES}/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2`,
    sha256: "9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d",
    sizeMB: 28,
    path: "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27",
    licence: "MIT (Moonshine, Useful Sensors)",
  },
  "kokoro-en": {
    default: true,
    url: `${RELEASES}/tts-models/kokoro-multi-lang-v1_0.tar.bz2`,
    sha256: "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4",
    sizeMB: 333,
    path: "kokoro-multi-lang-v1_0",
    files: { model: "model.onnx" },
    licence: "Apache-2.0 (Kokoro-82M)",
  },
  "kokoro-en-int8": {
    default: false,
    url: `${RELEASES}/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2`,
    sha256: "72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653",
    sizeMB: 126,
    path: "kokoro-int8-multi-lang-v1_0",
    files: { model: "model.int8.onnx" },
    licence: "Apache-2.0 (Kokoro-82M)",
  },
};

/** The model's directory (or file) under models/, with a clear error if it is missing. */
export function modelPath(name) {
  const model = MODELS[name];
  if (!model) throw new Error(`Unknown model "${name}". Known: ${Object.keys(MODELS).join(", ")}`);
  const path = MODELS_DIR + model.path;
  if (!existsSync(path)) {
    throw new Error(`Model "${name}" is not downloaded. Run: npm run models -- ${name}`);
  }
  return path;
}

/** Kokoro v1.0's English voices by speaker ID (sherpa-onnx's table; IDs 28 and up are other languages). */
export const KOKORO_VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova",
  "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];
