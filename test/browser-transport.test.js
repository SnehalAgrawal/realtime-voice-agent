// The browser protocol over a real WebSocket, with fake models (no downloads needed).

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";
import { AUDIO_HEADER_BYTES, decodeMicrophone, encodeAudioMessage, handleBrowser } from "../src/transports/browser.js";
import { fakeLLM, sleep } from "./helpers.js";

test("audio messages carry turn, index, and sample rate in a 12-byte header", () => {
  const message = encodeAudioMessage({ turn: 7, index: 2, audio: { samples: Int16Array.from([1, -2, 300]), sampleRate: 24000 } });
  assert.equal(message.length, AUDIO_HEADER_BYTES + 6);
  assert.deepEqual([message.readUInt32LE(0), message.readUInt32LE(4), message.readUInt32LE(8)], [7, 2, 24000]);
  assert.deepEqual([...decodeMicrophone(message.subarray(AUDIO_HEADER_BYTES))], [1, -2, 300]);
  // An odd byte offset (as a Buffer slice can have) still decodes.
  const unaligned = Buffer.concat([Buffer.from([0]), Buffer.from(Int16Array.from([5, -5]).buffer)]).subarray(1);
  assert.deepEqual([...decodeMicrophone(unaligned)], [5, -5]);
});

/** An endpointer that reports one utterance when it sees a frame whose first sample is 1. */
function markerEndpointer() {
  return {
    sampleRate: 16000,
    accept(samples) {
      if (samples[0] !== 1) return [];
      return [
        { type: "speech_start", sample: 0 },
        { type: "speech_end", audio: { samples: new Int16Array(16000), sampleRate: 16000 }, startSample: 0, endSample: 16000, decidedSample: 24000 },
      ];
    },
  };
}

let server;
let url;
before(async () => {
  const config = { ...loadConfig({}), greeting: "Hello there." };
  const providers = {
    llm: fakeLLM("It opens at nine. It closes at six."),
    stt: { name: "fake-stt", transcribe: async () => ({ text: "When do you open?" }) },
    tts: { name: "fake-tts", synthesize: async (text) => ({ samples: new Int16Array(text.length * 10).fill(3), sampleRate: 24000 }) },
  };
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (socket) => handleBrowser(socket, { providers, config, createEndpointer: markerEndpointer }));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${http.address().port}`;
  server = { close: () => new Promise((resolve) => { wss.close(); http.close(resolve); }) };
});
after(() => server.close());

/** A client that plays audio instantly and reports it played, like a very fast speaker. */
async function client({ play = true } = {}) {
  const socket = new WebSocket(url);
  const received = [];
  socket.on("message", (data, isBinary) => {
    if (!isBinary) return received.push(JSON.parse(data.toString()));
    const turn = data.readUInt32LE(0);
    const index = data.readUInt32LE(4);
    const samples = (data.length - AUDIO_HEADER_BYTES) / 2;
    received.push({ type: "audio", turn, index, sampleRate: data.readUInt32LE(8), samples });
    if (play) socket.send(JSON.stringify({ type: "played", turn, index, samples, done: true }));
  });
  await new Promise((resolve) => socket.on("open", resolve));
  const waitFor = async (predicate) => {
    for (let i = 0; i < 200 && !received.some(predicate); i++) await sleep(5);
    return received.find(predicate);
  };
  return { socket, received, waitFor };
}

test("ready, greeting, a spoken turn, and its timeline over the socket", async () => {
  const { socket, received, waitFor } = await client();
  const ready = await waitFor((m) => m.type === "ready");
  assert.deepEqual(ready.providers, { llm: "fake", stt: "fake-stt", tts: "fake-tts" });

  socket.send(JSON.stringify({ type: "start" }));
  assert.equal((await waitFor((m) => m.type === "turn_end" && m.turn === 1)).outcome, "completed");

  socket.send(Int16Array.from([1, 0, 0]).buffer);
  const end = await waitFor((m) => m.type === "turn_end" && m.turn === 2);
  assert.equal(end.outcome, "completed");
  assert.equal(end.transcript, "When do you open?");
  assert.ok(end.fromSpeechEnd.playback_done >= end.fromSpeechEnd.first_audio_sent);
  const audio = received.filter((m) => m.type === "audio" && m.turn === 2);
  assert.deepEqual(audio.map((a) => [a.index, a.sampleRate]), [[0, 24000], [1, 24000]]);
  assert.deepEqual(
    received.filter((m) => m.type === "reply_piece" && m.turn === 2).map((m) => m.text),
    ["It opens at nine.", "It closes at six."],
  );
  socket.close();
});

test("speech during playback sends clear and reports the interruption", async () => {
  const { socket, waitFor } = await client({ play: false });
  socket.send(Int16Array.from([1]).buffer);
  await waitFor((m) => m.type === "audio");
  socket.send(Int16Array.from([1]).buffer);
  assert.ok(await waitFor((m) => m.type === "clear"));
  const interrupted = await waitFor((m) => m.type === "interrupted");
  assert.equal(interrupted.heard, "");
  socket.close();
});

test("a malformed text message is answered with an error, and the session continues", async () => {
  const { socket, waitFor } = await client();
  socket.send("not json");
  assert.equal((await waitFor((m) => m.type === "stage_error")).stage, "protocol");
  socket.send(Int16Array.from([1]).buffer);
  assert.ok(await waitFor((m) => m.type === "turn_end"));
  socket.close();
});
