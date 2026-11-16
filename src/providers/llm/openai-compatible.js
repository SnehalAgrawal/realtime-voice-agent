// Any LLM served through an OpenAI-compatible chat completions API: OpenAI itself, and the
// many providers and servers that expose the same endpoint. Set the base URL, model, and key.

import { joinUrl, postJson, serverSentEvents } from "../http.js";

/** @returns {import("../types.js").LLMProvider} */
export function openAICompatibleLLM({
  baseUrl = "https://api.openai.com/v1",
  apiKey,
  model,
  temperature,
  seed,
  maxTokens = 512,
  timeoutMs = 60_000,
}) {
  if (!model) throw new Error("openai-compatible: LLM_MODEL is required");
  return {
    name: `openai-compatible:${model}`,
    async *stream(messages, { signal } = {}) {
      const body = { model, messages, stream: true, max_tokens: maxTokens };
      if (temperature !== undefined) body.temperature = temperature;
      if (seed !== undefined) body.seed = seed;
      const response = await postJson(joinUrl(baseUrl, "/chat/completions"), body, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal,
        timeoutMs,
      });
      for await (const data of serverSentEvents(response.body)) {
        if (data === "[DONE]") return;
        const event = JSON.parse(data);
        if (event.error) throw new Error(`openai-compatible: ${event.error.message ?? JSON.stringify(event.error)}`);
        const token = event.choices?.[0]?.delta?.content;
        if (token) yield token;
      }
    },
  };
}
