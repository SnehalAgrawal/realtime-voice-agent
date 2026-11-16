// Local LLM through Ollama's native chat API.
//
// The native API is used rather than Ollama's OpenAI-compatible endpoint because only the
// native one accepts `num_ctx`; without it, long conversations are silently truncated to
// the server's default context (measured in the Ollama article of this series).

import { joinUrl, lines, postJson } from "../http.js";

/** @returns {import("../types.js").LLMProvider} */
export function ollamaLLM({
  baseUrl = "http://127.0.0.1:11434",
  model,
  temperature,
  seed,
  numCtx = 8192,
  maxTokens = 512,
  keepAlive = "10m",
  timeoutMs = 120_000,
}) {
  if (!model) throw new Error("ollama: LLM_MODEL is required");
  return {
    name: `ollama:${model}`,
    async *stream(messages, { signal } = {}) {
      const options = { num_ctx: numCtx, num_predict: maxTokens };
      if (temperature !== undefined) options.temperature = temperature;
      if (seed !== undefined) options.seed = seed;
      const response = await postJson(
        joinUrl(baseUrl, "/api/chat"),
        { model, messages, stream: true, keep_alive: keepAlive, options },
        { signal, timeoutMs },
      );
      for await (const line of lines(response.body)) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(`ollama: ${event.error}`);
        if (event.message?.content) yield event.message.content;
        if (event.done) return;
      }
    },
  };
}
