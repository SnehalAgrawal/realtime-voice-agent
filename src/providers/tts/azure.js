// Text-to-speech through Azure AI Speech (REST, SSML) with a subscription key and region.
// Asks for raw 24 kHz 16-bit mono PCM.

import { postBody } from "../http.js";
import { pcm16le } from "./openai-compatible.js";

/** @returns {import("../types.js").TTSProvider} */
export function azureTTS({ apiKey, region, baseUrl, voice = "en-US-JennyNeural", timeoutMs = 30_000 } = {}) {
  if (!apiKey) throw new Error("azure TTS: TTS_API_KEY is required");
  if (!region && !baseUrl) throw new Error("azure TTS: TTS_REGION is required");
  const url = baseUrl ?? `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const language = voice.split("-").slice(0, 2).join("-");
  return {
    name: `azure:${voice}`,
    async synthesize(text, { signal } = {}) {
      const ssml = `<speak version="1.0" xml:lang="${language}"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
      const response = await postBody(url, ssml, {
        headers: {
          "content-type": "application/ssml+xml",
          "ocp-apim-subscription-key": apiKey,
          "x-microsoft-outputformat": "raw-24khz-16bit-mono-pcm",
          "user-agent": "realtime-voice-agent",
        },
        signal,
        timeoutMs,
      });
      return { samples: pcm16le(Buffer.from(await response.arrayBuffer())), sampleRate: 24000 };
    },
  };
}

export function escapeXml(text) {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}
