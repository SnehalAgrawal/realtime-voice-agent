"use strict";
const { SpeechClient } = require("@google-cloud/speech");

function createSttStream() {
  const client = new SpeechClient();
  const request = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: process.env.STT_LANGUAGE_CODE || "en-US",
    },
    interimResults: false,
  };
  return client.streamingRecognize(request);
}

module.exports = { createSttStream };
