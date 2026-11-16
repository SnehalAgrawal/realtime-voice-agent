// Phone calls through Plivo Audio Streams (bidirectional WebSocket), connected to the same
// voice session as the browser.
//
// Implemented from Plivo's protocol reference (docs.plivo.com, audio streaming reference,
// January 2026) and tested against a simulated Plivo client (test/plivo-transport.test.js,
// scripts/phone-check.js). It has not been run on a live call in this repository.
//
//   Plivo → server   start {start: {streamId, callId, mediaFormat: {encoding, sampleRate}}}
//                    media {media: {payload: base64}}, playedStream {name}, clearedAudio, dtmf
//   server → Plivo   playAudio {media: {contentType, sampleRate, payload}},
//                    checkpoint {streamId, name}, clearAudio {streamId}
//
// Defaults follow the original bot, which worked on live calls: Plivo streams 16 kHz PCM
// (answer XML contentType audio/x-l16;rate=16000) and replies go out as 8 kHz mu-law.
// Plivo's reference says playAudio must match the stream's format; PLIVO_PLAY_AUDIO=stream
// does that instead. Each piece (sentence) is sent as playAudio messages of at most 16 KB
// of base64, then a checkpoint; Plivo answers with playedStream when it has played. The
// original bot never used checkpoints or clearAudio, so if no playedStream arrives,
// playback is tracked by timing. Plivo does not report how far into a piece the caller
// got, so on barge-in that is estimated from the time since the piece started playing.

import { VoiceSession } from "../session.js";
import { Endpointer } from "../speech/endpointer.js";
import { decodeMuLaw, encodeMuLaw, resample } from "../speech/pcm.js";

/** The three formats Plivo supports for bidirectional streams. */
export const PLIVO_FORMATS = {
  "audio/x-mulaw;rate=8000": { encoding: "audio/x-mulaw", sampleRate: 8000 },
  "audio/x-l16;rate=8000": { encoding: "audio/x-l16", sampleRate: 8000 },
  "audio/x-l16;rate=16000": { encoding: "audio/x-l16", sampleRate: 16000 },
};

/** Base64 characters per playAudio payload (Plivo recommends 16 KB or less). */
export const MAX_PAYLOAD_CHARS = 16 * 1024;

/** The XML for Plivo's answer URL: stream the call to `streamUrl`, both ways. */
export function answerXml(streamUrl, contentType) {
  if (!PLIVO_FORMATS[contentType]) throw new Error(`Unsupported Plivo contentType: ${contentType}`);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n` +
    `  <Stream bidirectional="true" keepCallAlive="true" contentType="${contentType}">${escapeXml(streamUrl)}</Stream>\n` +
    `</Response>\n`
  );
}

/** Finds the format a start event describes. */
export function formatOf(mediaFormat = {}) {
  const entry = Object.entries(PLIVO_FORMATS).find(
    ([, f]) => f.encoding === mediaFormat.encoding && f.sampleRate === Number(mediaFormat.sampleRate),
  );
  if (!entry) throw new Error(`Unsupported stream format: ${JSON.stringify(mediaFormat)}`);
  return { contentType: entry[0], ...entry[1] };
}

/** Caller audio from a media payload, as 16-bit samples at the stream's rate. */
export function decodePayload(payload, format) {
  const bytes = Buffer.from(payload, "base64");
  if (format.encoding === "audio/x-mulaw") return decodeMuLaw(bytes);
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
  return samples;
}

/** Encodes samples (already at the stream's rate) in the stream's encoding. */
export function encodePayload(samples, format) {
  if (format.encoding === "audio/x-mulaw") return Buffer.from(encodeMuLaw(samples));
  const bytes = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(samples[i], i * 2);
  return bytes;
}

/** One reply piece as playAudio messages, each payload at most MAX_PAYLOAD_CHARS of base64. */
export function playAudioMessages(audio, format) {
  const samples = resample(audio.samples, audio.sampleRate, format.sampleRate);
  const bytesPerSample = format.encoding === "audio/x-mulaw" ? 1 : 2;
  // Base64 turns every 3 bytes into 4 characters.
  const samplesPerMessage = Math.floor(((MAX_PAYLOAD_CHARS / 4) * 3) / bytesPerSample / 2) * 2;
  const messages = [];
  for (let start = 0; start < samples.length; start += samplesPerMessage) {
    const payload = encodePayload(samples.subarray(start, start + samplesPerMessage), format).toString("base64");
    messages.push({ event: "playAudio", media: { contentType: format.encoding, sampleRate: format.sampleRate, payload } });
  }
  return messages;
}

export const checkpointName = (turn, index) => `turn-${turn}-piece-${index}`;

/** How long after a piece should have finished to stop waiting for its playedStream. */
export const PLAYED_STREAM_GRACE_MS = 1500;

/**
 * @param {import("ws").WebSocket} socket
 * @param {object} deps  as for handleBrowser, plus an optional clock
 */
export function handlePlivo(socket, { providers, config, log = () => {}, createEndpointer = (vad) => new Endpointer(vad), clock = () => performance.now() }) {
  let streamId = null;
  let format = null;
  let playFormat = null;
  let session = null;
  /** Pieces sent and not yet confirmed played, in order. */
  let playing = [];
  let warnedNoPlayedStream = false;

  const send = (message) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const durationMs = (piece) => (piece.audio.samples.length / piece.audio.sampleRate) * 1000;

  const transport = {
    play({ turn, index, audio }) {
      for (const message of playAudioMessages(audio, playFormat)) send(message);
      send({ event: "checkpoint", streamId, name: checkpointName(turn, index) });
      // If nothing is queued ahead of it, it starts playing now (plus network delay).
      playing.push({ turn, index, audio, startedAt: playing.length === 0 ? clock() : null });
    },
    clear() {
      // Report how far the current piece probably got, so the history keeps what was heard.
      const current = playing[0];
      if (current && current.startedAt !== null) {
        const elapsedSeconds = (clock() - current.startedAt) / 1000;
        const playedSamples = Math.min(current.audio.samples.length, Math.floor(elapsedSeconds * current.audio.sampleRate));
        session.playback({ turn: current.turn, index: current.index, playedSamples });
      }
      playing = [];
      send({ event: "clearAudio", streamId });
    },
  };

  const onPlayed = (name) => {
    const position = playing.findIndex((p) => checkpointName(p.turn, p.index) === name);
    if (position === -1) return; // cleared, or not ours
    const [done] = playing.splice(0, position + 1).slice(-1);
    if (playing[0]) playing[0].startedAt = clock();
    session.playback({ turn: done.turn, index: done.index, playedSamples: done.audio.samples.length, done: true });
  };

  // Fallback: if Plivo never confirms a checkpoint, count a piece as played once its
  // length plus a margin has passed, so turns still end and the history stays whole.
  const fallback = setInterval(() => {
    const head = playing[0];
    if (!session || !head || head.startedAt === null) return;
    if (clock() - head.startedAt < durationMs(head) + PLAYED_STREAM_GRACE_MS) return;
    if (!warnedNoPlayedStream) {
      warnedNoPlayedStream = true;
      log("plivo: no playedStream for a checkpoint; tracking playback by timing instead");
    }
    onPlayed(checkpointName(head.turn, head.index));
  }, 100);

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      log("plivo: ignored a message that is not JSON");
      return;
    }
    switch (message.event) {
      case "start": {
        streamId = message.start?.streamId ?? message.streamId ?? null;
        // The format asked for in the answer XML, unless the start message says otherwise.
        // (The original bot never read it; a missing or unknown one is not a reason to drop the call.)
        format = { contentType: config.plivo.contentType, ...PLIVO_FORMATS[config.plivo.contentType] };
        if (message.start?.mediaFormat) {
          try {
            format = formatOf(message.start.mediaFormat);
          } catch (error) {
            log(`plivo: ${error.message}; assuming ${format.contentType}, as requested in the answer XML`);
          }
        }
        playFormat = config.plivo.playAudio === "stream" ? format : PLIVO_FORMATS["audio/x-mulaw;rate=8000"];
        log(`plivo: call ${message.start?.callId ?? "?"} stream ${streamId} (in ${format.contentType}, replies ${playFormat.encoding} ${playFormat.sampleRate} Hz)`);
        session = new VoiceSession({
          ...providers,
          endpointer: createEndpointer(config.vad),
          systemPrompt: config.systemPrompt,
          reply: config.reply,
          bargeIn: config.bargeIn,
          transport,
        });
        session.on("turn_end", (e) =>
          log(`turn ${e.turn} ${e.outcome}: ${JSON.stringify(e.transcript)} → first audio sent ${e.fromSpeechEnd.first_audio_sent ?? "-"} ms`),
        );
        session.on("interrupted", (e) => log(`turn ${e.turn} interrupted; kept ${JSON.stringify(e.heard)}`));
        session.on("stage_error", ({ turn, stage, error }) => log(`turn ${turn} ${stage} error: ${error.message}`));
        socket.emit("session", session);
        if (config.greeting) session.greet(config.greeting);
        break;
      }
      case "media":
        if (session && message.media?.payload) {
          session.acceptAudio(resample(decodePayload(message.media.payload, format), format.sampleRate, 16000));
        }
        break;
      case "playedStream":
        if (session) onPlayed(message.name);
        break;
      case "clearedAudio":
        log("plivo: queued audio cleared");
        break;
      case "stop":
        session?.interrupt("call ended");
        break;
      default:
        break; // dtmf and anything newer are not used
    }
  });

  socket.on("close", () => {
    clearInterval(fallback);
    session?.interrupt("call ended");
    session?.removeAllListeners();
  });
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}
