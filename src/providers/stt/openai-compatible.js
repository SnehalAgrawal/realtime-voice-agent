// Speech-to-text through any OpenAI-compatible transcription endpoint
// (POST {base}/audio/transcriptions, multipart, with the utterance as a WAV file).

import { joinUrl, postForm } from "../http.js";
import { encodeWav } from "../../speech/pcm.js";

/** @returns {import("../types.js").STTProvider} */
export function openAICompatibleSTT({
  baseUrl = "https://api.openai.com/v1",
  apiKey,
  model = "gpt-4o-mini-transcribe",
  language = "en",
  timeoutMs = 30_000,
} = {}) {
  return {
    name: `openai-compatible:${model}`,
    async transcribe(audio, { signal } = {}) {
      const form = new FormData();
      form.append("file", new Blob([encodeWav(audio)], { type: "audio/wav" }), "utterance.wav");
      form.append("model", model);
      if (language) form.append("language", language.split("-")[0]);
      form.append("response_format", "json");
      const response = await postForm(joinUrl(baseUrl, "/audio/transcriptions"), form, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal,
        timeoutMs,
      });
      const { text } = await response.json();
      return { text: (text ?? "").trim() };
    },
  };
}
