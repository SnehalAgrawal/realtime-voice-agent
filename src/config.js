// All settings come from environment variables (see .env.example). The defaults run
// everything locally with no accounts or keys.

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a friendly voice assistant talking with someone on a live audio call.",
  "Everything you write is spoken aloud by a speech synthesiser, so reply in plain spoken English:",
  "one to three short sentences, with no lists, Markdown, emoji, or URLs.",
  "If you did not catch what the caller said, ask them to repeat it.",
].join(" ");

const PROVIDERS = {
  llm: ["ollama", "openai-compatible"],
  stt: ["local", "openai-compatible", "google"],
  tts: ["local", "openai-compatible", "azure"],
};

const LLM_DEFAULTS = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:3b" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: undefined },
};

/** Builds the configuration from an environment (process.env by default). */
export function loadConfig(env = process.env) {
  const llmProvider = choice(env, "LLM_PROVIDER", PROVIDERS.llm, "ollama");
  const llmDefaults = LLM_DEFAULTS[llmProvider];
  return {
    port: integer(env, "PORT", 8080),
    systemPrompt: env.SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
    llm: {
      provider: llmProvider,
      baseUrl: env.LLM_BASE_URL || llmDefaults.baseUrl,
      model: env.LLM_MODEL || llmDefaults.model,
      apiKey: env.LLM_API_KEY || undefined,
      temperature: number(env, "LLM_TEMPERATURE"),
      seed: integer(env, "LLM_SEED"),
      maxTokens: integer(env, "LLM_MAX_TOKENS", 512),
      numCtx: integer(env, "LLM_NUM_CTX", 8192),
    },
    stt: {
      provider: choice(env, "STT_PROVIDER", PROVIDERS.stt, "local"),
      baseUrl: env.STT_BASE_URL || undefined,
      model: env.STT_MODEL || undefined,
      apiKey: env.STT_API_KEY || undefined,
      language: env.STT_LANGUAGE || "en",
    },
    tts: {
      provider: choice(env, "TTS_PROVIDER", PROVIDERS.tts, "local"),
      baseUrl: env.TTS_BASE_URL || undefined,
      model: env.TTS_MODEL || undefined,
      voice: env.TTS_VOICE || undefined,
      apiKey: env.TTS_API_KEY || undefined,
      region: env.TTS_REGION || undefined,
    },
    reply: {
      chunking: { mode: choice(env, "CHUNKING", ["sentence", "clause", "whole"], "sentence") },
      ttsConcurrency: integer(env, "TTS_CONCURRENCY", 1),
    },
  };
}

function choice(env, name, allowed, fallback) {
  const value = env[name] || fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
  }
  return value;
}

function number(env, name, fallback) {
  if (env[name] === undefined || env[name] === "") return fallback;
  const value = Number(env[name]);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number (got "${env[name]}")`);
  return value;
}

function integer(env, name, fallback) {
  const value = number(env, name, fallback);
  if (value !== undefined && !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number (got "${env[name]}")`);
  }
  return value;
}

/** Loads `.env` from the working directory if there is one. */
export function loadEnvFile(path = ".env") {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
