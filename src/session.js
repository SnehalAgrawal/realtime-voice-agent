// One conversation: caller audio in, assistant audio out, whatever the transport
// (browser WebSocket, phone call, or the measurement harness).
//
//   caller audio → endpointer → speech-to-text → reply pipeline (LLM → sentences → TTS) → transport
//
// Barge-in: when the caller starts speaking while a turn is still in progress (thinking or
// playing), the turn is aborted, the transport drops any queued audio, and the assistant's
// message in the history is cut to what the caller actually heard, so the model's next
// reply does not assume they heard the rest.

import { EventEmitter } from "node:events";
import { speakReply } from "./pipeline/reply.js";
import { TurnTimeline } from "./pipeline/timeline.js";

/**
 * What a session needs from a transport. Audio is handed over in order, one piece
 * (sentence) at a time; the transport reports playback back through
 * `session.playback({ turn, index, playedSamples, done })`.
 *
 * @typedef {object} Transport
 * @property {(item: { turn: number, index: number, text: string, audio: import("./providers/types.js").Audio }) => void} play
 * @property {() => void} clear  stop playing now and drop queued audio
 */

// Events: turn_start, speech_start, transcript, reply_piece, interrupted, ignored, turn_end,
// and stage_error (not "error", which EventEmitter throws when nobody listens).
export class VoiceSession extends EventEmitter {
  #turn = null;
  #turns = 0;
  #speechStart = null;

  /**
   * @param {object} options
   * @param {import("./providers/types.js").LLMProvider} options.llm
   * @param {import("./providers/types.js").STTProvider} options.stt
   * @param {import("./providers/types.js").TTSProvider} options.tts
   * @param {{ accept(samples: Int16Array): object[], sampleRate: number }} options.endpointer
   * @param {Transport} options.transport
   * @param {string} options.systemPrompt
   * @param {object} [options.reply]  chunking and ttsConcurrency for the reply pipeline
   * @param {boolean} [options.bargeIn]
   * @param {() => number} [options.clock]
   */
  constructor({ llm, stt, tts, endpointer, transport, systemPrompt, reply = {}, bargeIn = true, clock = () => performance.now() }) {
    super();
    Object.assign(this, { llm, stt, tts, endpointer, transport, reply, bargeIn, clock });
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  /** True from the end of the caller's speech until the reply has finished playing. */
  get busy() {
    return Boolean(this.#turn?.active);
  }

  /** Speaks a fixed greeting (no model call) and records it in the history. */
  async greet(text) {
    const fixed = { name: "greeting", async *stream() { yield text; } };
    return this.#runTurn({ llm: fixed, greeting: text });
  }

  /** Caller audio: 16-bit PCM at the endpointer's sample rate, any length. */
  acceptAudio(samples) {
    for (const event of this.endpointer.accept(samples)) this.#onEndpoint(event);
  }

  /** Playback progress from the transport. `playedSamples` counts within the piece. */
  playback({ turn, index, playedSamples, done = false }) {
    const current = this.#turn;
    if (!current?.active || current.id !== turn) return;
    const piece = current.pieces[index];
    if (!piece) return;
    piece.played = Math.max(piece.played, done ? piece.samples : playedSamples);
    if (done) piece.done = true;
    this.#maybeFinish(current);
  }

  /** Stops the current turn (barge-in) and keeps only what was heard. */
  interrupt(reason = "barge-in") {
    const turn = this.#turn;
    if (!turn?.active) return;
    turn.controller.abort(new DOMException(reason, "AbortError"));
    this.transport.clear();
    const heard = heardText(turn.pieces);
    if (turn.assistantMessage) {
      if (heard) turn.assistantMessage.content = heard;
      else this.messages.splice(this.messages.indexOf(turn.assistantMessage), 1);
    } else if (heard) {
      this.messages.push({ role: "assistant", content: heard });
    }
    this.emit("interrupted", { turn: turn.id, reason, heard, replied: turn.replyText ?? null });
    this.#finish(turn, "interrupted");
  }

  #onEndpoint(event) {
    if (event.type === "speech_start") {
      this.#speechStart = { ...event, at: this.clock() };
      this.emit("speech_start", { sample: event.sample });
      if (this.bargeIn && this.busy) this.interrupt("barge-in");
      return;
    }
    if (this.busy) {
      // Only reached with barge-in off: the caller spoke over the reply, which keeps playing.
      this.emit("ignored", { reason: "assistant speaking", durationMs: msOf(event.audio) });
      return;
    }
    this.#runTurn({ utterance: event, speechStart: this.#speechStart });
    this.#speechStart = null;
  }

  async #runTurn({ utterance, speechStart, llm = this.llm, greeting }) {
    const turn = {
      id: ++this.#turns,
      active: true,
      controller: new AbortController(),
      timeline: new TurnTimeline({ clock: this.clock }),
      pieces: [],
      replyDone: false,
      assistantMessage: null,
    };
    this.#turn = turn;
    turn.timeline.mark("speech_end");
    const { signal } = turn.controller;
    if (utterance) {
      const rate = utterance.audio.sampleRate;
      turn.endpoint = {
        speechMs: msOf(utterance.audio),
        // How long the endpointer waited in silence before deciding the caller had finished.
        silenceWaitMs: Math.round(((utterance.decidedSample - utterance.endSample) / rate) * 1000),
        // How far into the speech the start was detected (what barge-in waits for).
        startDetectMs: speechStart ? Math.round(((speechStart.sample - utterance.startSample) / rate) * 1000) : null,
      };
    }
    this.emit("turn_start", { turn: turn.id, endpoint: turn.endpoint ?? null });

    try {
      if (utterance) {
        // Not aborted: if the caller talks again during transcription, what they said is still kept.
        const { text } = await this.stt.transcribe(utterance.audio);
        turn.timeline.mark("stt_final");
        turn.transcript = text;
        this.emit("transcript", { turn: turn.id, text });
        if (!text) return this.#finish(turn, "no speech recognised");
        this.messages.push({ role: "user", content: text });
        if (signal.aborted) return;
      }
      const result = await speakReply({
        llm,
        tts: this.tts,
        messages: [...this.messages],
        timeline: turn.timeline,
        signal,
        ...this.reply,
        deliver: (item) => this.#deliver(turn, item),
        onError: (error, context) => this.emit("stage_error", { turn: turn.id, stage: "tts", context, error }),
      });
      turn.replyText = result.text;
      turn.replyDone = true;
      if (!result.aborted && turn.active) {
        turn.assistantMessage = { role: "assistant", content: result.text };
        this.messages.push(turn.assistantMessage);
      }
      this.#maybeFinish(turn);
    } catch (error) {
      if (signal.aborted) return;
      this.emit("stage_error", { turn: turn.id, stage: greeting ? "greeting" : "reply", error });
      this.#finish(turn, "error");
    }
  }

  #deliver(turn, { text, audio, index }) {
    if (!turn.active) return;
    turn.pieces[index] = { text, samples: audio.samples.length, played: 0, done: false };
    this.transport.play({ turn: turn.id, index, text, audio });
    this.emit("reply_piece", { turn: turn.id, index, text, durationMs: msOf(audio), outOfVocabulary: audio.outOfVocabulary ?? [] });
  }

  #maybeFinish(turn) {
    if (!turn.active || !turn.replyDone) return;
    if (!turn.pieces.every((piece) => piece?.done)) return;
    if (turn.pieces.length) turn.timeline.mark("playback_done");
    this.#finish(turn, "completed");
  }

  #finish(turn, outcome) {
    if (!turn.active) return;
    turn.active = false;
    this.emit("turn_end", {
      turn: turn.id,
      outcome,
      transcript: turn.transcript ?? null,
      reply: turn.replyText ?? null,
      endpoint: turn.endpoint ?? null,
      fromSpeechEnd: turn.timeline.fromSpeechEnd(),
      breakdown: turn.timeline.breakdown(),
    });
  }
}

/**
 * The part of a reply the caller heard: every piece that finished playing, then the
 * words of a partly played piece in proportion to the samples played (an estimate:
 * speech rate is not perfectly even).
 */
export function heardText(pieces) {
  const parts = [];
  for (const piece of pieces) {
    if (!piece) break;
    if (piece.done || piece.played >= piece.samples) {
      parts.push(piece.text);
      continue;
    }
    if (piece.played > 0) {
      const words = piece.text.split(/\s+/);
      const count = Math.floor((words.length * piece.played) / piece.samples);
      if (count > 0) parts.push(words.slice(0, count).join(" "));
    }
    break;
  }
  return parts.join(" ");
}

function msOf(audio) {
  return Math.round((audio.samples.length / audio.sampleRate) * 1000);
}
