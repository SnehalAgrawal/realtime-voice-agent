import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SYSTEM_PROMPT, loadConfig } from "../src/config.js";
import { createLLM } from "../src/providers/index.js";

test("defaults run everything locally, with no keys", () => {
  const config = loadConfig({});
  assert.equal(config.llm.provider, "ollama");
  assert.equal(config.llm.baseUrl, "http://127.0.0.1:11434");
  assert.equal(config.llm.model, "qwen2.5:3b");
  assert.equal(config.llm.apiKey, undefined);
  assert.equal(config.stt.provider, "local");
  assert.equal(config.tts.provider, "local");
  assert.equal(config.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  assert.deepEqual(config.reply, { chunking: { mode: "sentence" }, ttsConcurrency: 1 });
  assert.equal(createLLM(config.llm).name, "ollama:qwen2.5:3b");
});

test("any OpenAI-compatible provider is configured by base URL, model, and key", () => {
  const config = loadConfig({
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "https://llm.example.com/v1",
    LLM_MODEL: "some-model",
    LLM_API_KEY: "secret",
    LLM_TEMPERATURE: "0.3",
  });
  assert.deepEqual(
    { ...config.llm },
    {
      provider: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      model: "some-model",
      apiKey: "secret",
      temperature: 0.3,
      seed: undefined,
      maxTokens: 512,
      numCtx: 8192,
    },
  );
  assert.equal(createLLM(config.llm).name, "openai-compatible:some-model");
});

test("the OpenAI-compatible provider needs a model name", () => {
  const config = loadConfig({ LLM_PROVIDER: "openai-compatible" });
  assert.equal(config.llm.baseUrl, "https://api.openai.com/v1");
  assert.throws(() => createLLM(config.llm), /LLM_MODEL is required/);
});

test("invalid values are rejected with the variable's name", () => {
  assert.throws(() => loadConfig({ LLM_PROVIDER: "gpt" }), /LLM_PROVIDER must be one of ollama, openai-compatible/);
  assert.throws(() => loadConfig({ CHUNKING: "words" }), /CHUNKING must be one of/);
  assert.throws(() => loadConfig({ LLM_TEMPERATURE: "warm" }), /LLM_TEMPERATURE must be a number/);
  assert.throws(() => loadConfig({ LLM_SEED: "4.2" }), /LLM_SEED must be a whole number/);
  assert.throws(() => loadConfig({ TTS_PROVIDER: "elevenlabs" }), /TTS_PROVIDER must be one of/);
});

test("a custom system prompt replaces the default", () => {
  assert.equal(loadConfig({ SYSTEM_PROMPT: "  Be brief.  " }).systemPrompt, "Be brief.");
});
