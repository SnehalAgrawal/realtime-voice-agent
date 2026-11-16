// npm start: loads the models and serves the browser client.

import { loadConfig, loadEnvFile } from "./config.js";
import { startServer } from "./server.js";

loadEnvFile();
const config = loadConfig();
console.log("Loading models ...");
const server = await startServer(config);
const { llm, stt, tts } = server.providers;
console.log(`LLM ${llm.name} | STT ${stt.name} | TTS ${tts.name}`);
console.log(`Open ${server.url} in a browser (headphones recommended).`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
