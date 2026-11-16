import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { fakeLLM } from "./helpers.js";

let server;
before(async () => {
  const providers = {
    llm: fakeLLM("Hi."),
    stt: { name: "stt", transcribe: async () => ({ text: "" }) },
    tts: { name: "tts", synthesize: async () => ({ samples: new Int16Array(10), sampleRate: 24000 }) },
  };
  server = await startServer({ ...loadConfig({}), port: 0 }, { providers, log: () => {} });
});
after(() => server.close());

/** A raw GET, so paths like /../ reach the server unnormalised. */
function get(path) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: server.port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body }));
    })
      .on("error", reject)
      .end();
  });
}

test("serves the client files", async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /Start conversation/);
  for (const file of ["/app.js", "/worklets.js", "/style.css"]) assert.equal((await get(file)).status, 200, file);
});

test("serves nothing outside public/", async () => {
  for (const path of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/missing.js", "/../src/config.js"]) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test("listens on localhost only by default", () => {
  assert.equal(loadConfig({}).host, "127.0.0.1");
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:/);
});

test("allows one conversation at a time by default", async () => {
  const first = new WebSocket(`ws://127.0.0.1:${server.port}/browser`);
  await new Promise((resolve) => first.on("message", resolve));
  const second = new WebSocket(`ws://127.0.0.1:${server.port}/browser`);
  const [code, reason] = await new Promise((resolve) => second.on("close", (c, r) => resolve([c, r.toString()])));
  assert.equal(code, 1013);
  assert.match(reason, /Another conversation is in progress/);
  first.close();
});
