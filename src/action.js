"use strict";
const { streamChatCompletion } = require("./gpt");
const { estimatePlaybackDuration } = require("./helper");
const { streamTts } = require("./tts");

function flushTextBuffer(ws) {
  if (!ws.textBuffer?.trim()) return;

  const completeSentence = ws.textBuffer.trim();
  ws.textBuffer = "";
  clearTimeout(ws.flushTimer);
  ws.flushTimer = null;

  console.log(
    `[${new Date().toISOString()}] [TTS Started]: `,
    completeSentence
  );

  streamTts(ws.tts, completeSentence)
    .then((audioStream) => {
      console.log(
        `[${new Date().toISOString()}] [TTS Done]: `,
        completeSentence
      );
      ws.send(
        JSON.stringify({
          event: "playAudio",
          media: {
            contentType: "audio/x-mulaw",
            sampleRate: 8000,
            payload: audioStream.content.toString("base64"),
          },
        })
      );
    })
    .catch((err) => {
      console.error(
        `[${new Date().toISOString()}] TTS error for:`,
        completeSentence,
        err
      );
    });
}

async function handleGptAndTts(ws, userInput) {
  if (userInput) {
    ws.messages.push({
      timestamp: new Date().toISOString(),
      role: "user",
      content: userInput,
    });
  }

  ws.textBuffer = "";
  if (ws.flushTimer) {
    clearTimeout(ws.flushTimer);
    ws.flushTimer = null;
  }

  const tokenStream = await streamChatCompletion(ws.messages);
  let llmResponse = "";

  tokenStream.on("data", (token) => {
    try {
      ws.textBuffer += token;
      llmResponse += token;

      // Flush immediately if we detect sentence end
      if (ws.textBuffer.length > 20 && /[;.!?]["']?\s*$/.test(ws.textBuffer)) {
        flushTextBuffer(ws);
      } else {
        // Reset debounce timer
        if (ws.flushTimer) clearTimeout(ws.flushTimer);
        ws.flushTimer = setTimeout(() => flushTextBuffer(ws), 1000);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Token stream error`, err);
    }
  });

  tokenStream.on("end", () => {
    // Flush any remaining buffer on end
    flushTextBuffer(ws);

    ws.messages.push({
      timestamp: new Date().toISOString(),
      role: "assistant",
      content: llmResponse,
    });
  });
}

module.exports = { handleGptAndTts };
