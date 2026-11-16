// Timestamps for one conversational turn, on one monotonic clock.
//
// The turn starts at the end of the caller's speech (the moment the voice activity
// detector decides they have stopped), and every later stage is measured from there.

/** Stages in pipeline order. Latency is reported from `speech_end` to each of them. */
export const STAGES = [
  "speech_end", // end of the caller's speech, as decided by the endpointer
  "stt_final", // transcript ready
  "llm_first_token", // first token streamed from the model
  "first_chunk", // first sentence (or clause) complete
  "first_audio", // first synthesised audio ready
  "first_audio_sent", // first audio handed to the transport
  "llm_done", // model finished streaming
  "playback_done", // all reply audio played (reported by the client)
];

/** The stages on the way to the first reply audio, which always happen in this order. */
export const CRITICAL_PATH = STAGES.slice(0, 6);

export class TurnTimeline {
  #clock;
  #marks = new Map();

  constructor({ clock = () => performance.now() } = {}) {
    this.#clock = clock;
  }

  /** Records a stage the first time it happens; later calls are ignored. */
  mark(stage, at = this.#clock()) {
    if (!STAGES.includes(stage)) throw new Error(`Unknown stage: ${stage}`);
    if (!this.#marks.has(stage)) this.#marks.set(stage, at);
    return this;
  }

  has(stage) {
    return this.#marks.has(stage);
  }

  /** Milliseconds from `speech_end` to every recorded stage, in pipeline order. */
  fromSpeechEnd() {
    const origin = this.#marks.get("speech_end");
    if (origin === undefined) return {};
    const out = {};
    for (const stage of STAGES) {
      if (this.#marks.has(stage)) out[stage] = round(this.#marks.get(stage) - origin);
    }
    return out;
  }

  /**
   * Milliseconds spent between consecutive recorded stages on the critical path,
   * e.g. `stt_final→llm_first_token`. (`llm_done` and `playback_done` can happen in
   * either order relative to the first audio, so they are reported only by fromSpeechEnd.)
   */
  breakdown() {
    const out = {};
    let previous = null;
    for (const stage of CRITICAL_PATH) {
      if (!this.#marks.has(stage)) continue;
      if (previous) out[`${previous}→${stage}`] = round(this.#marks.get(stage) - this.#marks.get(previous));
      previous = stage;
    }
    return out;
  }
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}
