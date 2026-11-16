// Speech-to-text through Google Cloud Speech-to-Text (v1 REST, speech:recognize) with an
// API key. One request per utterance, so the streaming API's time limit, which the
// original bot never handled, does not apply.

import { postJson } from "../http.js";
import { toRate } from "../../speech/pcm.js";

/** @returns {import("../types.js").STTProvider} */
export function googleSTT({
  baseUrl = "https://speech.googleapis.com/v1",
  apiKey,
  model,
  language = "en-US",
  timeoutMs = 30_000,
} = {}) {
  if (!apiKey) throw new Error("google STT: STT_API_KEY is required");
  const languageCode = language.includes("-") ? language : `${language}-US`;
  return {
    name: `google:${model ?? "default"}`,
    async transcribe(audio, { signal } = {}) {
      const { samples } = toRate(audio, 16000);
      const config = { encoding: "LINEAR16", sampleRateHertz: 16000, languageCode };
      if (model) config.model = model;
      const response = await postJson(
        `${baseUrl.replace(/\/+$/, "")}/speech:recognize?key=${encodeURIComponent(apiKey)}`,
        { config, audio: { content: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64") } },
        { signal, timeoutMs },
      );
      const { results = [] } = await response.json();
      const text = results.map((r) => r.alternatives?.[0]?.transcript ?? "").join(" ");
      return { text: text.replace(/\s+/g, " ").trim() };
    },
  };
}
