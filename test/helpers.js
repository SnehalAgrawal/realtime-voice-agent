// Fakes shared by the tests.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An LLM that streams the given text word by word, `delayMs` apart. */
export function fakeLLM(text, { delayMs = 5 } = {}) {
  return {
    name: "fake",
    calls: [],
    async *stream(messages, { signal } = {}) {
      this.calls.push(messages);
      for (const token of text.match(/\S+\s*/g) ?? []) {
        await sleep(delayMs);
        if (signal?.aborted) return;
        yield token;
      }
    },
  };
}

/**
 * A TTS whose synthesis time grows with text length, as a real engine's does.
 * The "audio" carries the text so tests can see what was delivered.
 */
export function fakeTTS({ msPerChar = 2 } = {}) {
  return {
    name: "fake",
    active: 0,
    maxActive: 0,
    async synthesize(text, { signal } = {}) {
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        await sleep(text.length * msPerChar);
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return { samples: new Int16Array(text.length), sampleRate: 16000, text };
      } finally {
        this.active--;
      }
    },
  };
}
