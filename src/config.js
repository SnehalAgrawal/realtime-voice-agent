// All settings come from environment variables (see .env.example). The defaults run
// everything locally with no accounts or keys.

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a friendly voice assistant talking with someone on a live audio call.",
  "Everything you write is spoken aloud by a speech synthesiser, so reply in plain spoken English:",
  "one to three short sentences, with no lists, Markdown, emoji, or URLs.",
  "If you did not catch what the caller said, ask them to repeat it.",
].join(" ");

export const DEFAULT_GREETING = "Hi! I'm a voice assistant running on this computer. What would you like to talk about?";

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
    // Local only by default: the server is reachable from this computer, not the network.
    host: env.HOST || "127.0.0.1",
    maxSessions: integer(env, "MAX_SESSIONS", 1),
    systemPrompt: env.SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
    greeting: env.GREETING === undefined ? DEFAULT_GREETING : env.GREETING.trim(),
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
      language: env.STT_LANGUAGE || undefined,
      numThreads: integer(env, "STT_THREADS", 2),
    },
    tts: {
      provider: choice(env, "TTS_PROVIDER", PROVIDERS.tts, "local"),
      baseUrl: env.TTS_BASE_URL || undefined,
      model: env.TTS_MODEL || undefined,
      voice: env.TTS_VOICE || undefined,
      apiKey: env.TTS_API_KEY || undefined,
      region: env.TTS_REGION || undefined,
      speed: number(env, "TTS_SPEED", 1),
      numThreads: integer(env, "TTS_THREADS", 4),
    },
    vad: {
      threshold: number(env, "VAD_THRESHOLD", 0.5),
      minSilenceMs: integer(env, "VAD_SILENCE_MS", 500),
      minSpeechMs: integer(env, "VAD_MIN_SPEECH_MS", 250),
      prerollMs: integer(env, "VAD_PREROLL_MS", 300),
    },
    bargeIn: boolean(env, "BARGE_IN", true),
    plivo: {
      // The defaults are what the original bot used on live calls: a 16 kHz PCM stream from
      // Plivo, and replies sent as 8 kHz mu-law.
      contentType: choice(env, "PLIVO_CONTENT_TYPE", ["audio/x-mulaw;rate=8000", "audio/x-l16;rate=8000", "audio/x-l16;rate=16000"], "audio/x-l16;rate=16000"),
      // "mulaw-8000": replies as 8 kHz mu-law, as the original bot sent them.
      // "stream": replies in the stream's own format, as Plivo's reference documents.
      playAudio: choice(env, "PLIVO_PLAY_AUDIO", ["mulaw-8000", "stream"], "mulaw-8000"),
      // The WebSocket URL Plivo should connect to; by default built from the request's Host (e.g. a tunnel).
      // STREAM_URL is the original bot's name for it.
      streamUrl: env.PLIVO_STREAM_URL || env.STREAM_URL || undefined,
      // If set, the stream URL carries ?token=..., and connections without it are refused.
      streamToken: env.PLIVO_STREAM_TOKEN || undefined,
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

function boolean(env, name, fallback) {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false (got "${env[name]}")`);
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
