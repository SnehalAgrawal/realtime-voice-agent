// One assistant reply: stream the model's tokens, cut them into sentences, synthesise each
// sentence as soon as it is complete, and deliver the audio strictly in order.
//
// Synthesis of later sentences overlaps playback of earlier ones (up to `ttsConcurrency`
// at a time); delivery order never depends on which synthesis finishes first.

import { OrderedQueue, createLimiter } from "./ordered-queue.js";
import { SentenceChunker, toSpeech } from "./sentence-chunker.js";
import { TurnTimeline } from "./timeline.js";

/**
 * @typedef {import("../providers/types.js").LLMProvider} LLMProvider
 * @typedef {import("../providers/types.js").TTSProvider} TTSProvider
 * @typedef {import("../providers/types.js").Audio} Audio
 *
 * @typedef {object} Piece
 * @property {string} text       the text as the model wrote it
 * @property {boolean} delivered whether its audio was handed to the transport
 */

/**
 * @param {object} options
 * @param {LLMProvider} options.llm
 * @param {TTSProvider} options.tts
 * @param {{ role: string, content: string }[]} options.messages  the conversation so far
 * @param {(item: { text: string, audio: Audio, index: number }) => (void | Promise<void>)} options.deliver
 * @param {TurnTimeline} [options.timeline]
 * @param {AbortSignal} [options.signal]  aborting stops generation, synthesis, and delivery (barge-in)
 * @param {{ mode?: "sentence" | "clause" | "whole", minClauseChars?: number }} [options.chunking]
 * @param {number} [options.ttsConcurrency]
 * @param {(error: Error, context: string) => void} [options.onError]
 * @returns {Promise<{ text: string, pieces: Piece[], aborted: boolean }>}
 */
export async function speakReply({
  llm,
  tts,
  messages,
  deliver,
  timeline = new TurnTimeline(),
  signal,
  chunking = {},
  ttsConcurrency = 1,
  onError = () => {},
}) {
  const chunker = new SentenceChunker(chunking);
  const limit = createLimiter(ttsConcurrency);
  /** @type {Piece[]} */
  const pieces = [];
  const queue = new OrderedQueue(
    async ({ piece, audio }, index) => {
      if (signal?.aborted) return;
      await deliver({ text: piece.text, audio, index });
      piece.delivered = true;
      timeline.mark("first_audio_sent");
    },
    { onError: (error, index) => onError(error, `piece ${index}`) },
  );
  signal?.addEventListener("abort", () => queue.cancel(), { once: true });

  const synthesise = (text) => {
    const piece = { text, delivered: false };
    pieces.push(piece);
    timeline.mark("first_chunk");
    const spoken = toSpeech(text);
    if (!spoken) return;
    const work = limit(async () => {
      if (signal?.aborted) throw abortError(signal);
      const audio = await tts.synthesize(spoken, { signal });
      timeline.mark("first_audio");
      return { piece, audio };
    });
    queue.push(work);
  };

  let text = "";
  let aborted = false;
  try {
    for await (const token of llm.stream(messages, { signal })) {
      if (signal?.aborted) break;
      if (!text) timeline.mark("llm_first_token");
      text += token;
      for (const sentence of chunker.push(token)) synthesise(sentence);
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
  if (signal?.aborted) {
    aborted = true;
  } else {
    timeline.mark("llm_done");
    for (const sentence of chunker.flush()) synthesise(sentence);
  }
  await queue.drained();
  return { text, pieces, aborted: aborted || Boolean(signal?.aborted) };
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
