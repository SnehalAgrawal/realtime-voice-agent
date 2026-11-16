// Connects one browser WebSocket to one voice session.
//
// Protocol (all PCM is 16-bit little-endian mono):
//
//   browser → server
//     binary                microphone audio, 16 kHz, any length (the client sends 20 ms frames)
//     {"type":"start"}      begin: the assistant speaks its greeting
//     {"type":"played", "turn", "index", "samples", "done"}
//                           playback progress of one reply piece, in that piece's samples
//
//   server → browser
//     binary                one reply piece: a 12-byte header (uint32 turn, uint32 index,
//                           uint32 sample rate, little-endian), then the samples
//     {"type":"clear"}      stop playback now and drop queued audio (barge-in)
//     {"type":"ready" | "speech_start" | "transcript" | "reply_piece" | "interrupted"
//            | "ignored" | "turn_end" | "stage_error", ...}
//                           session events, for the page to display

import { VoiceSession } from "../session.js";
import { Endpointer } from "../speech/endpointer.js";

export const AUDIO_HEADER_BYTES = 12;

/** Packs a reply piece into one binary message. */
export function encodeAudioMessage({ turn, index, audio }) {
  const { samples, sampleRate } = audio;
  const message = Buffer.alloc(AUDIO_HEADER_BYTES + samples.length * 2);
  message.writeUInt32LE(turn, 0);
  message.writeUInt32LE(index, 4);
  message.writeUInt32LE(sampleRate, 8);
  for (let i = 0; i < samples.length; i++) message.writeInt16LE(samples[i], AUDIO_HEADER_BYTES + i * 2);
  return message;
}

/** Reads microphone audio from a binary message (copying, since a Buffer may be unaligned). */
export function decodeMicrophone(data) {
  const samples = new Int16Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return samples;
}

/**
 * @param {import("ws").WebSocket} socket
 * @param {object} deps
 * @param {object} deps.providers  { llm, stt, tts }, shared by all sessions
 * @param {ReturnType<import("../config.js").loadConfig>} deps.config
 * @param {(line: string) => void} [deps.log]
 * @param {(config: object) => { accept(samples: Int16Array): object[], sampleRate: number }} [deps.createEndpointer]
 */
export function handleBrowser(socket, { providers, config, log = () => {}, createEndpointer = (vad) => new Endpointer(vad) }) {
  const send = (message) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const session = new VoiceSession({
    ...providers,
    endpointer: createEndpointer(config.vad),
    systemPrompt: config.systemPrompt,
    reply: config.reply,
    bargeIn: config.bargeIn,
    transport: {
      play: (item) => {
        if (socket.readyState === socket.OPEN) socket.send(encodeAudioMessage(item));
      },
      clear: () => send({ type: "clear" }),
    },
  });

  for (const type of ["speech_start", "transcript", "reply_piece", "interrupted", "ignored", "turn_end"]) {
    session.on(type, (event) => send({ type, ...event }));
  }
  session.on("turn_end", (e) => log(`turn ${e.turn} ${e.outcome}: ${JSON.stringify(e.transcript)} → first audio sent ${e.fromSpeechEnd.first_audio_sent ?? "-"} ms`));
  session.on("stage_error", ({ turn, stage, context, error }) => {
    log(`turn ${turn} ${stage} error: ${error.message}`);
    send({ type: "stage_error", turn, stage, context: context ?? null, message: error.message });
  });

  send({
    type: "ready",
    providers: { llm: providers.llm.name, stt: providers.stt.name, tts: providers.tts.name },
    settings: { silenceMs: config.vad.minSilenceMs, chunking: config.reply.chunking.mode, bargeIn: config.bargeIn },
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      session.acceptAudio(decodeMicrophone(data));
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return send({ type: "stage_error", stage: "protocol", message: "messages must be JSON or binary audio" });
    }
    if (message.type === "played") {
      session.playback({ turn: message.turn, index: message.index, playedSamples: message.samples, done: Boolean(message.done) });
    } else if (message.type === "start" && config.greeting) {
      session.greet(config.greeting);
    }
  });

  socket.on("close", () => {
    session.interrupt("disconnected");
    session.removeAllListeners();
  });
  return session;
}
