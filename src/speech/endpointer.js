// Decides when the caller starts and stops speaking, with the Silero voice activity
// detector (through sherpa-onnx). Runs on the server, so every stage of a turn is timed
// on one clock.
//
// The end of speech is only known after `minSilenceMs` of silence, so every turn pays
// that wait before anything else can start: it is the first setting the measurements vary.
//
// Each utterance starts `prerollMs` before the detector's segment: on the test audio the
// detector's segments began up to 350 ms after the speech did, and the first word
// ("Hi", "Can you") was lost from the transcript.

import { loadSherpa } from "./sherpa.js";
import { modelPath } from "./models.js";
import { float32ToInt16, int16ToFloat32 } from "./pcm.js";

const SAMPLE_RATE = 16000;
const WINDOW = 512; // Silero's window at 16 kHz (32 ms)

/**
 * @typedef {{ type: "speech_start", sample: number }
 *   | { type: "speech_end", audio: import("../providers/types.js").Audio, startSample: number, endSample: number, decidedSample: number }} EndpointEvent
 *   Sample positions count from the start of the stream, at 16 kHz.
 */

export class Endpointer {
  #vad;
  #pending = new Int16Array(0);
  #samples = 0;
  #inSpeech = false;
  #history;
  #preroll;

  constructor({ threshold = 0.5, minSilenceMs = 500, minSpeechMs = 250, maxSpeechS = 20, prerollMs = 300 } = {}) {
    const sherpa = loadSherpa();
    this.settings = { threshold, minSilenceMs, minSpeechMs, maxSpeechS, prerollMs };
    this.#preroll = Math.round((prerollMs / 1000) * SAMPLE_RATE);
    // Enough recent audio to rebuild the longest segment plus its pre-roll.
    this.#history = new Int16Array((maxSpeechS + 5) * SAMPLE_RATE + this.#preroll);
    this.#vad = new sherpa.Vad(
      {
        sileroVad: {
          model: modelPath("silero-vad"),
          threshold,
          minSilenceDuration: minSilenceMs / 1000,
          minSpeechDuration: minSpeechMs / 1000,
          maxSpeechDuration: maxSpeechS,
          windowSize: WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: 0,
      },
      maxSpeechS + 10,
    );
  }

  get sampleRate() {
    return SAMPLE_RATE;
  }

  /** Samples received so far. */
  get position() {
    return this.#samples;
  }

  /**
   * Takes 16 kHz audio of any length and returns what it completed.
   * @param {Int16Array} samples
   * @returns {EndpointEvent[]}
   */
  accept(samples) {
    const events = [];
    const buffer = new Int16Array(this.#pending.length + samples.length);
    buffer.set(this.#pending);
    buffer.set(samples, this.#pending.length);
    let offset = 0;
    for (; offset + WINDOW <= buffer.length; offset += WINDOW) {
      const window = buffer.subarray(offset, offset + WINDOW);
      this.#remember(window);
      this.#vad.acceptWaveform(int16ToFloat32(window));
      this.#samples += WINDOW;
      const detected = this.#vad.isDetected();
      if (detected && !this.#inSpeech) events.push({ type: "speech_start", sample: this.#samples });
      this.#inSpeech = detected;
      events.push(...this.#segments());
    }
    this.#pending = buffer.slice(offset);
    return events;
  }

  /** Ends the stream: returns the segment in progress, if any. */
  flush() {
    this.#vad.flush();
    this.#inSpeech = false;
    return this.#segments();
  }

  reset() {
    this.#vad.reset();
    this.#pending = new Int16Array(0);
    this.#inSpeech = false;
  }

  #segments() {
    const events = [];
    while (!this.#vad.isEmpty()) {
      const segment = this.#vad.front(false);
      this.#vad.pop();
      const endSample = segment.start + segment.samples.length;
      const from = Math.max(0, segment.start - this.#preroll, this.#samples - this.#history.length);
      const samples = from < segment.start ? this.#recall(from, endSample) : float32ToInt16(segment.samples);
      events.push({
        type: "speech_end",
        audio: { samples, sampleRate: SAMPLE_RATE },
        startSample: segment.start,
        endSample,
        decidedSample: this.#samples,
      });
    }
    return events;
  }

  /** Stores audio in the ring buffer at its stream position. */
  #remember(window) {
    const size = this.#history.length;
    for (let i = 0; i < window.length; i++) this.#history[(this.#samples + i) % size] = window[i];
  }

  /** Audio between two stream positions, from the ring buffer. */
  #recall(from, to) {
    const size = this.#history.length;
    const out = new Int16Array(to - from);
    for (let i = 0; i < out.length; i++) out[i] = this.#history[(from + i) % size];
    return out;
  }
}
