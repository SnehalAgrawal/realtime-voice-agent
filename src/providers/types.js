// The interfaces every provider implements. Local and cloud providers are interchangeable:
// the pipeline only ever sees these shapes, and configuration picks the implementation.

/**
 * Audio is always mono 16-bit PCM. Transports convert at the edge (for example to
 * 8 kHz mu-law for a phone call).
 *
 * @typedef {object} Audio
 * @property {Int16Array} samples
 * @property {number} sampleRate
 */

/**
 * @typedef {object} LLMProvider
 * @property {string} name
 * @property {(messages: { role: string, content: string }[], options?: { signal?: AbortSignal }) => AsyncIterable<string>} stream
 *   Streams the reply's text, token by token.
 */

/**
 * Transcribes one complete utterance (the voice activity detector decides where it ends).
 *
 * @typedef {object} STTProvider
 * @property {string} name
 * @property {(audio: Audio, options?: { signal?: AbortSignal }) => Promise<{ text: string }>} transcribe
 */

/**
 * Synthesises one piece of text (a sentence or a clause).
 *
 * @typedef {object} TTSProvider
 * @property {string} name
 * @property {(text: string, options?: { signal?: AbortSignal }) => Promise<Audio>} synthesize
 */

export {};
