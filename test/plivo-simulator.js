// A simulated Plivo bidirectional audio stream, following Plivo's protocol reference:
// it sends start and 20 ms media frames, queues playAudio, answers each checkpoint with
// playedStream once playback reaches it, and answers clearAudio with clearedAudio.
// Time advances one 20 ms tick at a time, so tests can run faster than real time and
// scripts can pace it to real time.

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { PLIVO_FORMATS, decodePayload, encodePayload } from "../src/transports/plivo.js";
import { resample } from "../src/speech/pcm.js";

const TICK_MS = 20;

export class PlivoSimulator {
  /**
   * @param {string} url
   * @param {object} [options]
   * @param {string} [options.contentType]  the stream's format
   * @param {boolean} [options.confirmCheckpoints]  answer checkpoints with playedStream (false: as if Plivo ignored them)
   * @param {boolean} [options.describeFormat]  include mediaFormat in the start message
   */
  constructor(url, { contentType = "audio/x-l16;rate=16000", confirmCheckpoints = true, describeFormat = true } = {}) {
    this.url = url;
    this.format = { contentType, ...PLIVO_FORMATS[contentType] };
    this.confirmCheckpoints = confirmCheckpoints;
    this.describeFormat = describeFormat;
    this.frame = (this.format.sampleRate * TICK_MS) / 1000;
    this.streamId = randomUUID();
    this.sequence = 0;
    this.chunk = 0;
    this.ticks = 0;
    this.callerQueue = [];
    /** Output queue: { samples } and { checkpoint } entries, in arrival order. */
    this.playback = [];
    this.received = [];
    this.callerTrack = [];
    this.agentTrack = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.on("message", (data) => this.#onMessage(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
      this.socket.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    this.#send({
      event: "start",
      start: {
        callId: randomUUID(),
        streamId: this.streamId,
        accountId: "SIMULATED",
        tracks: ["inbound"],
        ...(this.describeFormat ? { mediaFormat: { encoding: this.format.encoding, sampleRate: this.format.sampleRate } } : {}),
      },
      extra_headers: "",
    });
  }

  /** Queues caller speech (16 kHz samples); it is sent in real-time-sized frames by tick(). */
  say(samples16k) {
    const pending = this.callerQueue.reduce((n, s) => n + s.length, 0);
    this.callerQueue.push(resample(samples16k, 16000, this.format.sampleRate));
    return { startTick: this.ticks + Math.ceil(pending / this.frame) };
  }

  /** Advances 20 ms: sends one media frame (speech or silence), plays 20 ms of output. */
  tick() {
    this.ticks++;
    const frame = new Int16Array(this.frame);
    if (this.callerQueue.length) {
      const head = this.callerQueue[0];
      frame.set(head.subarray(0, this.frame));
      if (head.length <= this.frame) this.callerQueue.shift();
      else this.callerQueue[0] = head.subarray(this.frame);
    }
    this.callerTrack.push(frame);
    this.#send({
      event: "media",
      streamId: this.streamId,
      media: { track: "inbound", timestamp: String(this.ticks * TICK_MS), chunk: ++this.chunk, payload: encodePayload(frame, this.format).toString("base64") },
      extra_headers: "",
    });

    const out = new Int16Array(this.frame);
    let filled = 0;
    while (this.playback.length && (filled < this.frame || this.playback[0].checkpoint)) {
      const head = this.playback[0];
      if (head.checkpoint) {
        this.playback.shift();
        if (this.confirmCheckpoints) this.#send({ event: "playedStream", streamId: this.streamId, name: head.checkpoint });
        continue;
      }
      const take = Math.min(this.frame - filled, head.samples.length);
      out.set(head.samples.subarray(0, take), filled);
      filled += take;
      if (take === head.samples.length) this.playback.shift();
      else head.samples = head.samples.subarray(take);
    }
    this.agentTrack.push(out);
    return filled > 0;
  }

  get callerIdle() {
    return this.callerQueue.length === 0;
  }

  get playing() {
    return this.playback.some((entry) => entry.samples);
  }

  close() {
    this.#send({ event: "stop", streamId: this.streamId });
    this.socket.close();
  }

  #send(message) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ sequenceNumber: ++this.sequence, ...message }));
    }
  }

  #onMessage(message) {
    this.received.push({ tick: this.ticks, ...message });
    if (message.event === "playAudio") {
      // Played in the message's own format: the original bot sent 8 kHz mu-law on a 16 kHz
      // PCM stream, and that played on live calls.
      const { contentType, sampleRate, payload } = message.media;
      const format = { encoding: contentType, sampleRate: Number(sampleRate) };
      if (contentType !== this.format.encoding || format.sampleRate !== this.format.sampleRate) {
        this.received.push({ tick: this.ticks, event: "format_differs_from_stream", contentType, sampleRate });
      }
      this.playback.push({ samples: resample(decodePayload(payload, format), format.sampleRate, this.format.sampleRate) });
    } else if (message.event === "checkpoint") {
      this.playback.push({ checkpoint: message.name });
    } else if (message.event === "clearAudio") {
      this.playback = [];
      this.#send({ event: "clearedAudio", streamId: this.streamId });
    }
  }
}
