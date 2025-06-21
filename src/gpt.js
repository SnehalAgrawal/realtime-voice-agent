"use strict";
const OpenAI = require("openai");
const { PassThrough } = require("stream");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function streamChatCompletion(messages) {
  const stream = await openai.chat.completions.create(
    {
      model: process.env.GPT_MODEL || "gpt-4o-mini",
      messages,
      stream: true,
    },
    { responseType: "stream" }
  );
  const tokenStream = new PassThrough({ objectMode: true });

  (async () => {
    try {
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content;
        if (token) {
          tokenStream.write(token);
        }
      }
      tokenStream.end();
    } catch (err) {
      console.error("GPT stream error", err);
      tokenStream.destroy(err);
    }
  })();

  return tokenStream;
}

module.exports = { streamChatCompletion };
