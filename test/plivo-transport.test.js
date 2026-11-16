// The Plivo adapter against the simulated Plivo stream, with fake models.

import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { after, before, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
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
let logs = [];
/** The configuration the next connection gets (tests change it). */
let callConfig;
const baseConfig = { ...loadConfig({}), greeting: "Hello, thanks for calling." };

before(async () => {
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
    handlePlivo(socket, { providers, config: callConfig, log: (line) => logs.push(line), createEndpointer: loudnessEndpointer, clock: () => (sim?.ticks ?? 0) * 20 });
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

/** Greeting, then one spoken turn; returns the two turn summaries. */
async function greetingAndOneTurn() {
  const ends = [];
  await run(() => sessions.length > 0);
  sessions[0].on("turn_end", (e) => ends.push(e));
  await run(() => ends.length === 1);
  sim.say(loud(0.5));
  await run(() => ends.length === 2);
  return ends;
}

test("defaults match the original bot: a 16 kHz PCM stream, replies as 8 kHz mu-law", () => {
  assert.equal(baseConfig.plivo.contentType, "audio/x-l16;rate=16000");
  assert.equal(baseConfig.plivo.playAudio, "mulaw-8000");
  assert.equal(loadConfig({ STREAM_URL: "wss://old.example" }).plivo.streamUrl, "wss://old.example");
});

for (const playAudio of ["mulaw-8000", "stream"]) {
  for (const contentType of Object.keys(PLIVO_FORMATS)) {
    test(`a call on a ${contentType} stream, replies ${playAudio === "stream" ? "in the stream's format" : "as 8 kHz mu-law"}`, async () => {
      sessions = [];
      callConfig = { ...baseConfig, plivo: { ...baseConfig.plivo, contentType, playAudio } };
      sim = new PlivoSimulator(url, { contentType });
      await sim.connect();
      try {
        const ends = await greetingAndOneTurn();
        assert.equal(ends[0].outcome, "completed", "greeting played to its checkpoint");
        assert.equal(ends[1].outcome, "completed");
        assert.equal(ends[1].transcript, "Tell me something.");
        assert.ok(ends[1].fromSpeechEnd.playback_done > 0);

        const expected = playAudio === "stream" ? sim.format : PLIVO_FORMATS["audio/x-mulaw;rate=8000"];
        const sent = sim.received.filter((m) => m.event === "playAudio");
        assert.ok(sent.length > 0 && sent.every((m) => m.media.contentType === expected.encoding && m.media.sampleRate === expected.sampleRate));
        assert.deepEqual(
          sim.received.filter((m) => m.event === "checkpoint").map((m) => m.name),
          [checkpointName(1, 0), checkpointName(2, 0), checkpointName(2, 1)],
        );
        assert.ok(sim.received.filter((m) => m.event === "checkpoint").every((m) => m.streamId === sim.streamId));
        assert.deepEqual(sessions[0].messages.slice(1).map((m) => m.role), ["assistant", "user", "assistant"]);
      } finally {
        sim.close();
      }
    });
  }
}

test("the original bot's setup works without a format in the start message", async () => {
  sessions = [];
  logs = [];
  callConfig = baseConfig;
  sim = new PlivoSimulator(url, { describeFormat: false });
  await sim.connect();
  try {
    const ends = await greetingAndOneTurn();
    assert.deepEqual(ends.map((e) => e.outcome), ["completed", "completed"]);
    assert.ok(logs.some((l) => l.includes("in audio/x-l16;rate=16000, replies audio/x-mulaw 8000 Hz")));
  } finally {
    sim.close();
  }
});

test("if Plivo never confirms checkpoints, playback is tracked by timing and turns still end", async () => {
  sessions = [];
  logs = [];
  callConfig = baseConfig;
  sim = new PlivoSimulator(url, { confirmCheckpoints: false });
  await sim.connect();
  try {
    const ends = await greetingAndOneTurn();
    assert.deepEqual(ends.map((e) => e.outcome), ["completed", "completed"]);
    assert.ok(!sim.received.some((m) => m.event === "playedStream"));
    assert.equal(logs.filter((l) => l.includes("tracking playback by timing")).length, 1, "warned once");
    // The whole reply stays in the history.
    assert.equal(sessions[0].messages.at(-1).content, "One two three four five six seven eight nine ten. Eleven twelve.");
  } finally {
    sim.close();
  }
});

test("barge-in sends clearAudio and keeps the words played before it, estimated from time", async () => {
  sessions = [];
  callConfig = baseConfig;
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

test("an unknown format in the start message falls back to the configured one instead of dropping the call", async () => {
  sessions = [];
  logs = [];
  callConfig = baseConfig;
  sim = new PlivoSimulator(url);
  sim.format = { ...sim.format, encoding: "audio/x-l16", sampleRate: 16000 };
  const original = sim.connect.bind(sim);
  sim.connect = async () => {
    // Announce a format that does not exist, then stream 16 kHz PCM as configured.
    sim.format = { contentType: "audio/x-l16;rate=16000", encoding: "audio/x-unknown", sampleRate: 16000 };
    await original();
    sim.format = { contentType: "audio/x-l16;rate=16000", ...PLIVO_FORMATS["audio/x-l16;rate=16000"] };
  };
  await sim.connect();
  try {
    const ends = await greetingAndOneTurn();
    assert.deepEqual(ends.map((e) => e.outcome), ["completed", "completed"]);
    assert.ok(logs.some((l) => l.includes("assuming audio/x-l16;rate=16000")));
  } finally {
    sim.close();
  }
});

// --- Through the real server: answer URLs, stream paths, and the token -----------

/** POSTs to the answer URL with a given Host header and returns the XML. */
function answer(port, path, host) {
  return new Promise((resolve) => {
    request({ host: "127.0.0.1", port, path, method: "POST", headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).end("CallUUID=1");
  });
}

const fakeProviders = () => ({
  llm: fakeLLM("Hi."),
  stt: { name: "s", transcribe: async () => ({ text: "" }) },
  tts: { name: "t", synthesize: async () => ({ samples: new Int16Array(1), sampleRate: 8000 }) },
});

test("the server answers Plivo with stream XML, and refuses streams without the token", async () => {
  const config = { ...loadConfig({ PLIVO_STREAM_TOKEN: "s3cret" }), port: 0 };
  const app = await startServer(config, { providers: fakeProviders(), log: () => {} });
  try {
    const xml = await answer(app.port, "/plivo/answer", "abc.tunnel.example");
    assert.match(xml, /contentType="audio\/x-l16;rate=16000">wss:\/\/abc\.tunnel\.example\/plivo\?token=s3cret<\/Stream>/);
    for (const path of ["/plivo?token=wrong", "/plivo", "/", "/?token=nope"]) {
      await assert.rejects(new PlivoSimulator(`ws://127.0.0.1:${app.port}${path}`).connect(), /403/, path);
    }
    for (const path of ["/plivo?token=s3cret", "/?token=s3cret"]) {
      const socket = new WebSocket(`ws://127.0.0.1:${app.port}${path}`);
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.close();
    }
  } finally {
    await app.close();
  }
});

test("the original bot's answer URL (/answer.xml), STREAM_URL, and root stream path still work", async () => {
  const config = { ...loadConfig({ STREAM_URL: "wss://abc.ngrok.example" }), port: 0, greeting: "Hello." };
  const app = await startServer(config, { providers: fakeProviders(), log: () => {} });
  try {
    const xml = await answer(app.port, "/answer.xml", "abc.ngrok.example");
    assert.match(xml, /<Stream bidirectional="true" keepCallAlive="true" contentType="audio\/x-l16;rate=16000">wss:\/\/abc\.ngrok\.example\/<\/Stream>/);
    // Plivo connects to the root path, as with the original bot.
    sim = new PlivoSimulator(`ws://127.0.0.1:${app.port}/`, { describeFormat: false });
    await sim.connect();
    await run(() => sim.received.some((m) => m.event === "checkpoint"));
    const greeting = sim.received.filter((m) => m.event === "playAudio");
    assert.ok(greeting.length > 0 && greeting.every((m) => m.media.contentType === "audio/x-mulaw" && m.media.sampleRate === 8000));
    sim.close();
  } finally {
    await app.close();
  }
});
