// Text-to-speech through any OpenAI-compatible speech endpoint
// (POST {base}/audio/speech). Asks for raw PCM: 24 kHz, 16-bit, mono, little-endian,
// which is what OpenAI documents for response_format "pcm".

import { joinUrl, postJson } from "../http.js";

/** @returns {import("../types.js").TTSProvider} */
export function openAICompatibleTTS({
  baseUrl = "https://api.openai.com/v1",
  apiKey,
  model = "gpt-4o-mini-tts",
  voice = "alloy",
  sampleRate = 24000,
  timeoutMs = 30_000,
} = {}) {
  return {
    name: `openai-compatible:${model}:${voice}`,
    async synthesize(text, { signal } = {}) {
      const response = await postJson(
        joinUrl(baseUrl, "/audio/speech"),
        { model, voice, input: text, response_format: "pcm" },
        { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal, timeoutMs },
      );
      return { samples: pcm16le(Buffer.from(await response.arrayBuffer())), sampleRate };
    },
  };
}

export function pcm16le(bytes) {
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
  return samples;
}
