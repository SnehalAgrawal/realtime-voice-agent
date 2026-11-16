// The HTTP and WebSocket server: serves the browser client from public/ and connects
// each browser WebSocket (/browser) to a voice session. Models are loaded once and shared.
//
// One conversation at a time by default (MAX_SESSIONS): local models on a laptop are
// sized for one caller, and a second caller would slow the first one's replies.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createLLM, createSTT, createTTS } from "./providers/index.js";
import { handleBrowser } from "./transports/browser.js";

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

  const browsers = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path !== "/browser") return socket.destroy();
    browsers.handleUpgrade(req, socket, head, (ws) => {
      if (sessions.size >= config.maxSessions) {
        ws.close(1013, "Another conversation is in progress. Try again later.");
        return;
      }
      sessions.add(ws);
      log(`browser connected (${sessions.size} active)`);
      handleBrowser(ws, { providers, config, log: (line) => log(`  ${line}`) });
      ws.on("close", () => {
        sessions.delete(ws);
        log(`browser disconnected (${sessions.size} active)`);
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
        for (const ws of browsers.clients) ws.terminate();
        browsers.close();
        server.close(resolve);
      }),
  };
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}
