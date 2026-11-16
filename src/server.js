// The HTTP and WebSocket server. Serves the browser client from public/, connects each
// browser WebSocket (/browser) and each Plivo call (/plivo, answer XML at /plivo/answer)
// to a voice session. Models are loaded once and shared.
//
// One conversation at a time by default (MAX_SESSIONS): local models on a laptop are
// sized for one caller, and a second caller would slow the first one's replies.

import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createLLM, createSTT, createTTS } from "./providers/index.js";
import { handleBrowser } from "./transports/browser.js";
import { answerXml, handlePlivo } from "./transports/plivo.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Loads every provider (the local models take a second or two). */
export async function loadProviders(config) {
  const [stt, tts] = await Promise.all([createSTT(config.stt), createTTS(config.tts)]);
  return { llm: createLLM(config.llm), stt, tts };
}

/**
 * @param {ReturnType<import("./config.js").loadConfig>} config
 * @param {{ providers?: object, log?: (line: string) => void }} [options]
 */
export async function startServer(config, { providers, log = (line) => console.log(line) } = {}) {
  providers ??= await loadProviders(config);
  const sessions = new Set();

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/plivo/answer" && (req.method === "GET" || req.method === "POST")) {
      req.resume();
      const streamUrl = new URL(config.plivo.streamUrl ?? `wss://${req.headers.host}/plivo`);
      if (config.plivo.streamToken) streamUrl.searchParams.set("token", config.plivo.streamToken);
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(answerXml(streamUrl.toString(), config.plivo.contentType));
      return;
    }
    const file = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
    const type = TYPES[extname(file)];
    if (req.method !== "GET" || !file.startsWith(PUBLIC) || !type) return notFound(res);
    try {
      if (!(await stat(file)).isFile()) return notFound(res);
    } catch {
      return notFound(res);
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const handlers = { "/browser": handleBrowser, "/plivo": handlePlivo };
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const handler = handlers[url.pathname];
    if (!handler) return socket.destroy();
    if (url.pathname === "/plivo" && config.plivo.streamToken && !sameSecret(url.searchParams.get("token"), config.plivo.streamToken)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const kind = url.pathname.slice(1);
    sockets.handleUpgrade(req, socket, head, (ws) => {
      if (sessions.size >= config.maxSessions) {
        ws.close(1013, "Another conversation is in progress. Try again later.");
        return;
      }
      sessions.add(ws);
      log(`${kind} connected (${sessions.size} active)`);
      handler(ws, { providers, config, log: (line) => log(`  ${line}`) });
      ws.on("close", () => {
        sessions.delete(ws);
        log(`${kind} disconnected (${sessions.size} active)`);
      });
    });
  });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address();
  return {
    url: `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${port}`,
    port,
    providers,
    close: () =>
      new Promise((resolve) => {
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
        server.close(resolve);
      }),
  };
}

function sameSecret(given, expected) {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}
