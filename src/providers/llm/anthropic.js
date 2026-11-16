// Claude through the official Anthropic SDK (@anthropic-ai/sdk), streamed.
//
// Differences from the other LLM providers, from the Claude API documentation:
// - The system prompt is a separate `system` parameter, not a message.
// - Current models reject temperature and seed, so they are not sent.
// - Thinking cannot be turned off on Claude Opus 5.5; its depth is set with
//   output_config.effort. A voice reply is short conversation, so the default here is
//   "low" (LLM_EFFORT changes it).
// - Thinking counts against max_tokens, so the default is generous (16,000); a spoken
//   reply itself is a few sentences.
// - If Claude declines a request, the API retries it on a fallback model chosen by the
//   reason (server-side fallbacks, beta "server-side-fallback-2026-07-01").
// The API key comes from LLM_API_KEY, or the SDK's usual ANTHROPIC_API_KEY.

import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/** @returns {import("../types.js").LLMProvider} */
export function anthropicLLM({ apiKey, baseUrl, model = DEFAULT_CLAUDE_MODEL, maxTokens = 16000, effort = "low", timeoutMs = 60_000, client } = {}) {
  const anthropic = client ?? new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseURL: baseUrl } : {}), timeout: timeoutMs });
  return {
    name: `anthropic:${model}`,
    async *stream(messages, { signal } = {}) {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const turns = messages.filter((m) => m.role !== "system").map(({ role, content }) => ({ role, content }));
      const stream = anthropic.beta.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: turns,
          output_config: { effort },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
      }
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        throw new Error(`anthropic: the request was declined (${message.stop_details?.category ?? "no category"})`);
      }
    },
  };
}
