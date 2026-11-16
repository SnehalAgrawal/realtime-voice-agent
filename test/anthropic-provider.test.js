// The Claude provider against a local mock of the Messages API's streaming format
// (server-sent events: message_start, content_block_delta with text_delta, ...).

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { anthropicLLM } from "../src/providers/llm/anthropic.js";

let server;
let baseUrl;
let last;
let stopReason = "end_turn";

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

before(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    last = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const message = { id: "msg_1", type: "message", role: "assistant", model: last.body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    res.write(sse("message_start", { message }));
    res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Our clinic opens" } }));
    res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: " at nine." } }));
    res.write(sse("content_block_stop", { index: 0 }));
    res.write(sse("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null, ...(stopReason === "refusal" ? { stop_details: { type: "refusal", category: "cyber", explanation: "test" } } : {}) }, usage: { output_tokens: 6 } }));
    res.end(sse("message_stop", {}));
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

test("streams text and sends the system prompt, effort, and fallbacks as the Messages API expects", async () => {
  stopReason = "end_turn";
  const llm = anthropicLLM({ apiKey: "sk-ant-test", baseUrl });
  const tokens = await all(
    llm.stream([
      { role: "system", content: "Be brief." },
      { role: "user", content: "When do you open?" },
    ]),
  );
  assert.deepEqual(tokens, ["Our clinic opens", " at nine."]);
  assert.match(last.url, /^\/v1\/messages/);
  // SDK 1.3.0 sends the key as a bearer token, with API version 2026-10-21.
  assert.equal(last.headers.authorization, "Bearer sk-ant-test");
  assert.equal(last.headers["anthropic-version"], "2026-10-21");
  assert.match(last.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(last.body.model, "claude-opus-5-5");
  assert.equal(last.body.system, "Be brief.");
  assert.deepEqual(last.body.messages, [{ role: "user", content: "When do you open?" }]);
  assert.equal(last.body.stream, true);
  assert.equal(last.body.max_tokens, 16000);
  assert.deepEqual(last.body.output_config, { effort: "low" });
  assert.equal(last.body.fallbacks, "default");
  assert.equal(last.body.temperature, undefined, "no sampling parameters");
});

test("a declined request raises an error with its category", async () => {
  stopReason = "refusal";
  const llm = anthropicLLM({ apiKey: "sk-ant-test", baseUrl });
  await assert.rejects(all(llm.stream([{ role: "user", content: "x" }])), /declined \(cyber\)/);
  stopReason = "end_turn";
});

test("an aborted request (barge-in) stops instead of streaming", async () => {
  const llm = anthropicLLM({ apiKey: "sk-ant-test", baseUrl });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(all(llm.stream([{ role: "user", content: "x" }], { signal: controller.signal })), (error) => {
    assert.match(error.name + error.message, /Abort/i);
    return true;
  });
});

test("the reply pipeline treats an aborted Claude stream as a barge-in, not an error", async () => {
  const { speakReply } = await import("../src/pipeline/reply.js");
  const llm = anthropicLLM({ apiKey: "sk-ant-test", baseUrl });
  const controller = new AbortController();
  controller.abort();
  const result = await speakReply({
    llm,
    tts: { name: "t", synthesize: async () => ({ samples: new Int16Array(1), sampleRate: 16000 }) },
    messages: [{ role: "user", content: "x" }],
    signal: controller.signal,
    deliver: () => {},
  });
  assert.equal(result.aborted, true);
});
