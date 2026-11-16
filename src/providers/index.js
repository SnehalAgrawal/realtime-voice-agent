// Picks each stage's provider from the configuration.

import { ollamaLLM } from "./llm/ollama.js";
import { openAICompatibleLLM } from "./llm/openai-compatible.js";

const LLMS = {
  ollama: ollamaLLM,
  "openai-compatible": openAICompatibleLLM,
};

/** @returns {import("./types.js").LLMProvider} */
export function createLLM(config) {
  const factory = LLMS[config.provider];
  if (!factory) throw new Error(`Unknown LLM provider: ${config.provider}`);
  return factory(config);
}
