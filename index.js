"use strict";
require("dotenv").config();
const uWS = require("uWebSockets.js");
const { createSttStream } = require("./src/stt");
const { getAzureSpeechSynthesizer } = require("./src/tts");
const { handleGptAndTts } = require("./src/action");
const { convertToTranscript } = require("./src/helper");

const PORT = parseInt(process.env.PORT || "5555");
const STREAM_URL = process.env.STREAM_URL;

uWS
  .App()
  .post("/answer.xml", (res, req) => {
    if (!STREAM_URL) {
      res
        .writeStatus("500 Internal Server Error")
        .end("STREAM_URL not configured");
      return;
    }
    const xml = `<Response>
        <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000">${STREAM_URL}</Stream>
    </Response>`;
    res.writeHeader("Content-Type", "application/xml").end(xml);
  })
  .ws("/*", {
    maxPayloadLength: 1024 * 1024,
    compression: 0, // don't use compression
    message: (ws, message, isBinary) => {
      let msg;
      try {
        let text = Buffer.from(message).toString();
        msg = JSON.parse(text);

        if (msg.event === "start") {
          console.log(`[${new Date().toISOString()}] Call started`);
          ws.messages = [
            {
              timestamp: new Date().toISOString(),
              role: "system",
              content: `Prompt Here`,
            },
            {
              timestamp: new Date().toISOString(),
              role: "user",
              content: `START`,
            },
          ];

          // Prewarm STT
          ws.stt = createSttStream();
          ws.stt.on("error", (err) =>
            console.error(`[${new Date().toISOString()}] STT error`, err)
          );
          ws.stt.on("data", (data) => {
            const result = data.results[0];
            const transcript = result?.alternatives[0]?.transcript;
            const isFinal = result?.isFinal;
            if (transcript) {
              console.log(
                `[${new Date().toISOString()}] [Transcript (${
                  isFinal ? "final" : "partial"
                }): ${transcript}]`
              );
              handleGptAndTts(ws, transcript);
            }
          });

          // Prewarm TTS
          ws.tts = getAzureSpeechSynthesizer();

          handleGptAndTts(ws, null);
        } else if (msg.event === "media" && msg.media?.payload) {
          const audioBuffer = Buffer.from(msg.media.payload, "base64");
          if (ws.stt) ws.stt.write(audioBuffer);
        } else if (msg.event === "stop") {
          console.log(`[${new Date().toISOString()}] Received stop event`);
          if (ws.stt) ws.stt.end();
        } else if (msg.event === "playedStream") {
          console.log(
            `[${new Date().toISOString()}] Played event called, name: ${
              msg.name
            }`
          );
        }
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] Error parsing message:`,
          error
        );
        ws.end(1003, "Invalid message format");
      }
    },
    open: (ws) => {
      console.log(`[${new Date().toISOString()}] Client connected`);
    },
    close: (ws, code, message) => {
      console.log(
        `[${new Date().toISOString()}] Client disconnected with code ${code} and message ${JSON.stringify(
          message
        )}`
      );
      if (ws.stt) ws.stt.end();
      if (ws.tts) ws.tts.close();
      if (ws.messages) console.log(convertToTranscript(ws.messages));
    },
  })
  .listen(PORT, (token) => {
    if (token) {
      console.log(
        `[${new Date().toISOString()}] Server listening on port ${PORT}`
      );
    } else {
      console.error(
        `[${new Date().toISOString()}] Failed to listen to port`,
        PORT
      );
    }
  });

process.on("uncaughtException", (err) => {
  console.error(`[${new Date().toISOString()}] Uncaught Exception:`, err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    `[${new Date().toISOString()}] Unhandled Rejection at:`,
    promise,
    "reason:",
    reason
  );
});
