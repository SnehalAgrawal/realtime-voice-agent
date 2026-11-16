// The HTTP LLM adapters against a local mock server that speaks each API's streaming format.
// Responses are written in small, uneven pieces so that events split across network chunks.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { ollamaLLM } from "../src/providers/llm/ollama.js";
import { openAICompatibleLLM } from "../src/providers/llm/openai-compatible.js";
import { sleep } from "./helpers.js";

let server;
let baseUrl;
let requests = [];
let respond;

before(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    await respond(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function all(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

/** Writes `text` in pieces of `size` bytes. */
async function writeInPieces(res, text, size = 7) {
  for (let i = 0; i < text.length; i += size) {
    res.write(text.slice(i, i + size));
    await sleep(1);
  }
  res.end();
}

test("ollama: sends the native chat request with num_ctx and streams the tokens", async () => {
  requests = [];
  respond = (req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const events = [
      { message: { role: "assistant", content: "Hello" }, done: false },
      { message: { role: "assistant", content: " there." }, done: false },
      { message: { role: "assistant", content: "" }, done: true, eval_count: 2 },
    ];
    return writeInPieces(res, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };
  const llm = ollamaLLM({ baseUrl, model: "qwen2.5:3b", temperature: 0, seed: 42, numCtx: 4096, maxTokens: 64 });
  const messages = [{ role: "user", content: "Hi" }];
  assert.deepEqual(await all(llm.stream(messages)), ["Hello", " there."]);
  assert.equal(requests[0].url, "/api/chat");
  assert.deepEqual(requests[0].body, {
    model: "qwen2.5:3b",
    messages,
    stream: true,
    keep_alive: "10m",
    options: { num_ctx: 4096, num_predict: 64, temperature: 0, seed: 42 },
  });
});

test("ollama: an error status is raised with the server's message", async () => {
  respond = (req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: 'model "nope" not found, try pulling it first' }));
  };
  const llm = ollamaLLM({ baseUrl, model: "nope" });
  await assert.rejects(all(llm.stream([])), /404 .*model "nope" not found/);
});

test("ollama: an error event in the stream is raised", async () => {
  respond = (req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ message: { content: "Hi" } }) + "\n" + JSON.stringify({ error: "out of memory" }) + "\n");
  };
  await assert.rejects(all(ollamaLLM({ baseUrl, model: "m" }).stream([])), /ollama: out of memory/);
});

test("openai-compatible: sends the key and the chat request, parses server-sent events", async () => {
  requests = [];
  respond = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      { choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " there." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    return writeInPieces(res, sse, 5);
  };
  const llm = openAICompatibleLLM({ baseUrl: `${baseUrl}/v1/`, apiKey: "test-key", model: "some-model", temperature: 0.2 });
  assert.deepEqual(await all(llm.stream([{ role: "user", content: "Hi" }])), ["Hello", " there."]);
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
  assert.deepEqual(requests[0].body, {
    model: "some-model",
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
    max_tokens: 512,
    temperature: 0.2,
  });
});

test("openai-compatible: sends no authorization header without a key", async () => {
  requests = [];
  respond = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: [DONE]\n\n");
  };
  await all(openAICompatibleLLM({ baseUrl, model: "m" }).stream([]));
  assert.equal(requests[0].headers.authorization, undefined);
});

test("openai-compatible: an error status is raised with the response body", async () => {
  respond = (req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
  };
  const llm = openAICompatibleLLM({ baseUrl, apiKey: "wrong", model: "m" });
  await assert.rejects(all(llm.stream([])), /401 .*Incorrect API key provided/);
});

test("aborting stops the stream", async () => {
  respond = async (req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (let i = 0; i < 50 && !res.destroyed; i++) {
      res.write(JSON.stringify({ message: { content: `t${i} ` }, done: false }) + "\n");
      await sleep(10);
    }
    res.end();
  };
  const controller = new AbortController();
  const tokens = [];
  const llm = ollamaLLM({ baseUrl, model: "m" });
  await assert.rejects(
    (async () => {
      for await (const token of llm.stream([], { signal: controller.signal })) {
        tokens.push(token);
        if (tokens.length === 3) controller.abort();
      }
    })(),
    { name: "AbortError" },
  );
  assert.equal(tokens.length, 3);
});

test("a model name is required", () => {
  assert.throws(() => ollamaLLM({ baseUrl }), /LLM_MODEL is required/);
  assert.throws(() => openAICompatibleLLM({ baseUrl }), /LLM_MODEL is required/);
});
