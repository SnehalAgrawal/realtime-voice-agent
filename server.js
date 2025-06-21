"use strict";
// Simple Express server for testing chat UI against the OpenAI-based bot
require("dotenv").config();
const express = require("express");
const path = require("path");
const { streamChatCompletion } = require("./src/gpt");

const app = express();
const PORT = process.env.CHAT_UI_PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Chat API endpoint: accepts { message: string }, returns { response: string, timeMs: number }
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "No message provided" });
  }
  const startTime = Date.now();
  let content = "";
  const stream = await streamChatCompletion([
    { role: "user", content: message },
  ]);
  stream.on("data", (token) => {
    content += token;
  });
  stream.on("end", () => {
    const timeMs = Date.now() - startTime;
    res.json({ response: content, timeMs });
  });
  stream.on("error", (err) => {
    console.error("Chat stream error", err);
    res.status(500).json({ error: err.message });
  });
});

app.listen(PORT, () => {
  console.log(`Chat UI listening at http://localhost:${PORT}`);
});
