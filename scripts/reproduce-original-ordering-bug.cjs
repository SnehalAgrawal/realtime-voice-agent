// Reproduces the out-of-order audio bug in the original bot (commit f1b77c0).
//
// The original src/action.js runs unchanged; only its LLM and TTS modules are replaced
// by fakes: the LLM streams a long sentence then a short one, and synthesis time grows
// with text length. Usage:
//
//   git worktree add ../original-bot f1b77c0
//   node scripts/reproduce-original-ordering-bug.cjs ../original-bot
//   git worktree remove ../original-bot
//
// The same scenario is the regression test in test/ordering.test.js.
"use strict";
const Module = require("module");
const { PassThrough } = require("stream");
const path = require("path");
const REPO = path.resolve(process.argv[2] ?? "");

const SENTENCES = [
  "Sure, I can book that appointment for you on Tuesday morning at the downtown clinic. ",
  "Anything else today? ",
];
const fakes = {
  "./gpt": {
    async streamChatCompletion() {
      const s = new PassThrough({ objectMode: true });
      const tokens = SENTENCES.join("").match(/\S+\s*/g);
      (async () => {
        for (const t of tokens) { await new Promise(r => setTimeout(r, 10)); s.write(t); }
        s.end();
      })();
      return s;
    },
  },
  "./tts": {
    // Synthesis time grows with text length (2 ms per character), as with a real engine.
    streamTts(_tts, text) {
      return new Promise(r => setTimeout(() => r({ content: Buffer.from(text) }), text.length * 2));
    },
  },
};
const load = Module._load;
Module._load = function (request, parent, _isMain) {
  if (parent && parent.filename.startsWith(path.join(REPO, "src")) && fakes[request]) return fakes[request];
  return load.apply(this, arguments);
};
const { handleGptAndTts } = require(path.join(REPO, "src/action.js"));
const sent = [];
const ws = { messages: [], send: m => sent.push(Buffer.from(JSON.parse(m).media.payload, "base64").toString()) };
handleGptAndTts(ws, "Book me in for Tuesday").then(() => setTimeout(() => {
  console.log("LLM order: ", SENTENCES.map(s => JSON.stringify(s.trim())).join(" -> "));
  console.log("sent order:", sent.map(s => JSON.stringify(s)).join(" -> "));
  const inOrder = sent.join(" ") === SENTENCES.map(s => s.trim()).join(" ");
  console.log(inOrder ? "IN ORDER" : "OUT OF ORDER (bug reproduced)");
  process.exitCode = inOrder ? 0 : 1;
}, 1500));
