// The hosted speech providers against a local mock server, using the request and
// response shapes in each provider's documentation. They are not tested against the
// live services here (that needs keys); see the README.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { googleSTT } from "../src/providers/stt/google.js";
import { openAICompatibleSTT } from "../src/providers/stt/openai-compatible.js";
import { azureTTS, escapeXml } from "../src/providers/tts/azure.js";
import { openAICompatibleTTS } from "../src/providers/tts/openai-compatible.js";
import { decodeWav } from "../src/speech/pcm.js";

let server;
let baseUrl;
let last;
let respond;

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    last = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    await respond(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const audio = { samples: Int16Array.from({ length: 1600 }, (_, i) => (i % 50) * 100), sampleRate: 16000 };

/** Parses a multipart body into { name: value } (files as Buffers). */
async function parseForm(headers, body) {
  const form = await new Response(body, { headers: { "content-type": headers["content-type"] } }).formData();
  const out = {};
  for (const [name, value] of form) out[name] = typeof value === "string" ? value : Buffer.from(await value.arrayBuffer());
  return out;
}

test("openai-compatible STT posts the utterance as a WAV file and returns the text", async () => {
  respond = (req, res) => res.end(JSON.stringify({ text: " When are you open? " }));
  const stt = openAICompatibleSTT({ baseUrl: `${baseUrl}/v1`, apiKey: "k", model: "whisper-x", language: "en-US" });
  assert.deepEqual(await stt.transcribe(audio), { text: "When are you open?" });
  assert.equal(last.url, "/v1/audio/transcriptions");
  assert.equal(last.headers.authorization, "Bearer k");
  const form = await parseForm(last.headers, last.body);
  assert.equal(form.model, "whisper-x");
  assert.equal(form.language, "en");
  assert.deepEqual(decodeWav(form.file), audio);
});

test("google STT sends LINEAR16 at 16 kHz with the key in the query, and joins results", async () => {
  respond = (req, res) =>
    res.end(JSON.stringify({ results: [{ alternatives: [{ transcript: "When are you" }] }, { alternatives: [{ transcript: " open" }] }] }));
  const stt = googleSTT({ baseUrl, apiKey: "secret key", language: "en" });
  assert.deepEqual(await stt.transcribe({ samples: new Int16Array(800), sampleRate: 8000 }), { text: "When are you open" });
  assert.equal(last.url, "/speech:recognize?key=secret%20key");
  const body = JSON.parse(last.body);
  assert.deepEqual(body.config, { encoding: "LINEAR16", sampleRateHertz: 16000, languageCode: "en-US" });
  assert.equal(Buffer.from(body.audio.content, "base64").length, 1600 * 2, "resampled to 16 kHz");
});

test("google STT keeps the key out of error messages", async () => {
  respond = (req, res) => {
    res.writeHead(403);
    res.end(JSON.stringify({ error: { message: "API key not valid." } }));
  };
  await assert.rejects(googleSTT({ baseUrl, apiKey: "secret" }).transcribe(audio), (error) => {
    assert.match(error.message, /403 .*API key not valid/);
    assert.ok(!error.message.includes("secret"));
    return true;
  });
});

test("google STT returns empty text when nothing was recognised", async () => {
  respond = (req, res) => res.end("{}");
  assert.deepEqual(await googleSTT({ baseUrl, apiKey: "k" }).transcribe(audio), { text: "" });
});

test("openai-compatible TTS asks for raw PCM and decodes it", async () => {
  const pcm = Buffer.alloc(8);
  [1, -1, 300, -300].forEach((v, i) => pcm.writeInt16LE(v, i * 2));
  respond = (req, res) => res.end(pcm);
  const tts = openAICompatibleTTS({ baseUrl, apiKey: "k", voice: "nova" });
  const result = await tts.synthesize("Hello.");
  assert.deepEqual([...result.samples], [1, -1, 300, -300]);
  assert.equal(result.sampleRate, 24000);
  assert.equal(last.url, "/audio/speech");
  assert.deepEqual(JSON.parse(last.body), { model: "gpt-4o-mini-tts", voice: "nova", input: "Hello.", response_format: "pcm" });
});

test("azure TTS sends escaped SSML with the key and output format", async () => {
  respond = (req, res) => res.end(Buffer.alloc(4));
  const tts = azureTTS({ apiKey: "k", baseUrl: `${baseUrl}/cognitiveservices/v1`, voice: "en-IN-KavyaNeural" });
  const result = await tts.synthesize("Fish & chips <today>");
  assert.equal(result.samples.length, 2);
  assert.equal(last.headers["ocp-apim-subscription-key"], "k");
  assert.equal(last.headers["x-microsoft-outputformat"], "raw-24khz-16bit-mono-pcm");
  assert.equal(
    last.body.toString(),
    '<speak version="1.0" xml:lang="en-IN"><voice name="en-IN-KavyaNeural">Fish &amp; chips &lt;today&gt;</voice></speak>',
  );
});

test("azure TTS and google STT need their keys", () => {
  assert.throws(() => azureTTS({ region: "eastus" }), /TTS_API_KEY is required/);
  assert.throws(() => azureTTS({ apiKey: "k" }), /TTS_REGION is required/);
  assert.throws(() => googleSTT({}), /STT_API_KEY is required/);
  assert.equal(escapeXml(`"a" & 'b'`), "&quot;a&quot; &amp; &apos;b&apos;");
});
