// The Plivo adapter against the simulated Plivo stream, with fake models.

import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import {
  MAX_PAYLOAD_CHARS, PLIVO_FORMATS, answerXml, checkpointName, decodePayload, encodePayload, formatOf, handlePlivo, playAudioMessages,
} from "../src/transports/plivo.js";
import { fakeLLM, sleep } from "./helpers.js";
import { PlivoSimulator } from "./plivo-simulator.js";

test("answer XML streams both ways, keeps the call alive, and escapes the URL", () => {
  assert.equal(
    answerXml("wss://example.test/plivo?token=a&b", "audio/x-mulaw;rate=8000"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n' +
      '  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">wss://example.test/plivo?token=a&amp;b</Stream>\n' +
      "</Response>\n",
  );
  assert.throws(() => answerXml("wss://x", "audio/x-mulaw;rate=16000"), /Unsupported/);
});

test("formatOf accepts exactly the three documented formats", () => {
  assert.equal(formatOf({ encoding: "audio/x-mulaw", sampleRate: 8000 }).contentType, "audio/x-mulaw;rate=8000");
  assert.equal(formatOf({ encoding: "audio/x-l16", sampleRate: "16000" }).contentType, "audio/x-l16;rate=16000");
  assert.throws(() => formatOf({ encoding: "audio/x-mulaw", sampleRate: 16000 }), /Unsupported stream format/);
  assert.throws(() => formatOf(undefined), /Unsupported stream format/);
});

test("playAudio payloads stay within 16 KB of base64 and use the stream's format", () => {
  const audio = { samples: Int16Array.from({ length: 24000 * 3 }, (_, i) => (i % 100) * 50), sampleRate: 24000 };
  for (const [contentType, format] of Object.entries(PLIVO_FORMATS)) {
    const messages = playAudioMessages(audio, format);
    const total = messages.reduce((n, m) => n + decodePayload(m.media.payload, format).length, 0);
    assert.equal(total, format.sampleRate * 3, `${contentType}: 3 s of audio at the stream's rate`);
    for (const m of messages) {
      assert.ok(m.media.payload.length <= MAX_PAYLOAD_CHARS, `${contentType}: ${m.media.payload.length} chars`);
      assert.deepEqual([m.event, m.media.contentType, m.media.sampleRate], ["playAudio", format.encoding, format.sampleRate]);
    }
    assert.ok(messages.length >= 2, `${contentType}: split into ${messages.length} messages`);
  }
  const l16 = PLIVO_FORMATS["audio/x-l16;rate=16000"];
  assert.deepEqual([...decodePayload(encodePayload(Int16Array.from([1, -1, 32767]), l16).toString("base64"), l16)], [1, -1, 32767]);
});

// --- Over a WebSocket, with the simulator --------------------------------------

/** Speech is any frame louder than 10,000: one frame starts it, one silent frame ends it. */
function loudnessEndpointer() {
  let speaking = false;
  return {
    sampleRate: 16000,
    accept(samples) {
      const loud = samples.some((v) => Math.abs(v) > 10000);
      if (loud && !speaking) {
        speaking = true;
        return [{ type: "speech_start", sample: 0 }];
      }
      if (!loud && speaking) {
        speaking = false;
        return [{ type: "speech_end", audio: { samples: new Int16Array(16000), sampleRate: 16000 }, startSample: 0, endSample: 16000, decidedSample: 24000 }];
      }
      return [];
    },
  };
}

let server;
let url;
let sim;
let sessions = [];
before(async () => {
  const config = { ...loadConfig({}), greeting: "Hello, thanks for calling." };
  const providers = {
    llm: fakeLLM("One two three four five six seven eight nine ten. Eleven twelve."),
    stt: { name: "fake-stt", transcribe: async () => ({ text: "Tell me something." }) },
    // 0.3 s of audio per word, at 24 kHz.
    tts: { name: "fake-tts", synthesize: async (text) => ({ samples: new Int16Array(text.split(" ").length * 7200).fill(1000), sampleRate: 24000 }) },
  };
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (socket) => {
    socket.on("session", (session) => sessions.push(session));
    // The simulator's clock: 20 ms per tick, so barge-in estimates are deterministic.
    handlePlivo(socket, { providers, config, createEndpointer: loudnessEndpointer, clock: () => (sim?.ticks ?? 0) * 20 });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${http.address().port}`;
  server = {
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        http.close(resolve);
      }),
  };
});
after(() => server.close());

/** Ticks the simulator (fast, not real time) until `done()` or a tick limit. */
async function run(done, limit = 2000) {
  for (let i = 0; i < limit && !done(); i++) {
    sim.tick();
    await sleep(0);
  }
}

const loud = (seconds) => new Int16Array(16000 * seconds).fill(20000);

for (const contentType of Object.keys(PLIVO_FORMATS)) {
  test(`a call in ${contentType}: greeting, a turn, checkpoints answered, history kept`, async () => {
    sessions = [];
    sim = new PlivoSimulator(url, { contentType });
    await sim.connect();
    const ends = [];
    await run(() => sessions.length > 0);
    sessions[0].on("turn_end", (e) => ends.push(e));
    await run(() => ends.length === 1);
    assert.equal(ends[0].outcome, "completed", "greeting played to its checkpoint");

    sim.say(loud(0.5));
    await run(() => ends.length === 2);
    assert.equal(ends[1].outcome, "completed");
    assert.equal(ends[1].transcript, "Tell me something.");
    assert.ok(ends[1].fromSpeechEnd.playback_done > 0);

    const sent = sim.received.filter((m) => m.event === "playAudio");
    assert.ok(sent.every((m) => m.media.contentType === sim.format.encoding && m.media.sampleRate === sim.format.sampleRate));
    assert.deepEqual(
      sim.received.filter((m) => m.event === "checkpoint").map((m) => m.name),
      [checkpointName(1, 0), checkpointName(2, 0), checkpointName(2, 1)],
    );
    assert.ok(sim.received.filter((m) => m.event === "checkpoint").every((m) => m.streamId === sim.streamId));
    assert.equal(sim.received.filter((m) => m.event === "format_mismatch").length, 0);
    assert.deepEqual(sessions[0].messages.slice(1).map((m) => m.role), ["assistant", "user", "assistant"]);
    sim.close();
  });
}

test("barge-in sends clearAudio and keeps the words played before it, estimated from time", async () => {
  sessions = [];
  sim = new PlivoSimulator(url);
  await sim.connect();
  await run(() => sessions.length > 0);
  const session = sessions[0];
  let interrupted = null;
  session.on("interrupted", (e) => (interrupted = e));
  await run(() => !session.busy); // greeting done

  try {
    sim.say(loud(0.5));
    await run(() => sim.playing);
    // The first sentence is 10 words, 3 s. Interrupt 1.5 s into it.
    for (let i = 0; i < 75; i++) sim.tick();
    await sleep(5);
    sim.say(loud(0.5));
    const cleared = () => sim.received.some((m) => m.event === "clearAudio" && m.streamId === sim.streamId);
    // The server reports the interruption as it sends clearAudio; wait for the message to arrive.
    await run(() => interrupted !== null && cleared());

    assert.ok(interrupted, "interrupted");
    assert.ok(cleared(), "clearAudio received");
    assert.equal(sim.playing, false, "the simulator's queue was cleared");
    const words = interrupted.heard.split(" ");
    assert.ok(words.length >= 4 && words.length <= 6, `about half of the 10 words: ${JSON.stringify(interrupted.heard)}`);
    assert.ok(!interrupted.heard.includes("Eleven"));
  } finally {
    sim.close();
  }
});

test("a start with an unsupported format closes the stream", async () => {
  sim = new PlivoSimulator(url);
  sim.format = { encoding: "audio/x-mulaw", sampleRate: 16000 };
  const closed = new Promise((resolve) => setTimeout(resolve, 1000));
  await sim.connect();
  const code = await Promise.race([new Promise((resolve) => sim.socket.on("close", (c) => resolve(c))), closed]);
  assert.equal(code, 1003);
});

// --- Through the real server: answer URL and stream token ------------------------

test("the server answers Plivo with stream XML, and refuses streams without the token", async () => {
  const providers = { llm: fakeLLM("Hi."), stt: { name: "s", transcribe: async () => ({ text: "" }) }, tts: { name: "t", synthesize: async () => ({ samples: new Int16Array(1), sampleRate: 8000 }) } };
  const config = { ...loadConfig({ PLIVO_STREAM_TOKEN: "s3cret", PLIVO_CONTENT_TYPE: "audio/x-l16;rate=16000" }), port: 0 };
  const app = await startServer(config, { providers, log: () => {} });
  try {
    const xml = await new Promise((resolve) => {
      request({ host: "127.0.0.1", port: app.port, path: "/plivo/answer", method: "POST", headers: { host: "abc.tunnel.example" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      }).end("CallUUID=1");
    });
    assert.match(xml, /contentType="audio\/x-l16;rate=16000">wss:\/\/abc\.tunnel\.example\/plivo\?token=s3cret<\/Stream>/);

    await assert.rejects(new PlivoSimulator(`ws://127.0.0.1:${app.port}/plivo?token=wrong`).connect(), /403/);
    await assert.rejects(new PlivoSimulator(`ws://127.0.0.1:${app.port}/plivo`).connect(), /403/);
    const ok = new PlivoSimulator(`ws://127.0.0.1:${app.port}/plivo?token=s3cret`);
    ok.socket = null;
    const { WebSocket } = await import("ws");
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/plivo?token=s3cret`);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.close();
  } finally {
    await app.close();
  }
});
