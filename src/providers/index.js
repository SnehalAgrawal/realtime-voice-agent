// Picks each stage's provider from the configuration. Local providers load their models,
// so the speech factories are async.

import { ollamaLLM } from "./llm/ollama.js";
import { openAICompatibleLLM } from "./llm/openai-compatible.js";
import { googleSTT } from "./stt/google.js";
import { localSTT } from "./stt/local.js";
import { openAICompatibleSTT } from "./stt/openai-compatible.js";
import { azureTTS } from "./tts/azure.js";
import { localTTS } from "./tts/local.js";
import { openAICompatibleTTS } from "./tts/openai-compatible.js";

const LLMS = { ollama: ollamaLLM, "openai-compatible": openAICompatibleLLM };
const STTS = { local: localSTT, "openai-compatible": openAICompatibleSTT, google: googleSTT };
const TTSS = { local: localTTS, "openai-compatible": openAICompatibleTTS, azure: azureTTS };

/** Drops undefined settings so each provider's own defaults apply. */
const defined = (config) => Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));

/** @returns {import("./types.js").LLMProvider} */
export function createLLM(config) {
  return pick(LLMS, "LLM", config.provider)(defined(config));
}

/** @returns {Promise<import("./types.js").STTProvider>} */
export async function createSTT(config) {
  return pick(STTS, "STT", config.provider)(defined(config));
}

/** @returns {Promise<import("./types.js").TTSProvider>} */
export async function createTTS(config) {
  return pick(TTSS, "TTS", config.provider)(defined(config));
}

function pick(table, stage, provider) {
  const factory = table[provider];
  if (!factory) throw new Error(`Unknown ${stage} provider: ${provider}`);
  return factory;
}
