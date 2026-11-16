// A text conversation in the terminal through the same reply pipeline the voice path uses,
// with the speech stages left out. Shows each sentence as it would be handed to
// text-to-speech, and the time from sending the message to the first token and sentence.
//
//   npm run chat
//   echo "When are you open?" | npm run chat     (one turn per input line)

import { createInterface } from "node:readline/promises";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { speakReply } from "../src/pipeline/reply.js";
import { TurnTimeline } from "../src/pipeline/timeline.js";
import { createLLM } from "../src/providers/index.js";

loadEnvFile();
const config = loadConfig();
const llm = createLLM(config.llm);
/** Stands in for text-to-speech: hands each sentence straight through. */
const textOnly = { name: "text-only", synthesize: async (text) => ({ samples: new Int16Array(0), sampleRate: 16000, text }) };

const messages = [{ role: "system", content: config.systemPrompt }];
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
console.log(`LLM: ${llm.name}. Type a message; an empty line or Ctrl+D ends the chat.\n`);

const tty = process.stdin.isTTY;
rl.setPrompt("you> ");
if (tty) rl.prompt();
// The async iterator buffers lines, so piped input is not lost while a reply streams.
for await (const input of rl) {
  const line = input.trim();
  if (!line) break;
  if (!tty) console.log(`you> ${line}`);
  messages.push({ role: "user", content: line });

  // The turn starts when the message is sent (in the voice path: when the caller stops speaking).
  const timeline = new TurnTimeline();
  timeline.mark("speech_end");
  process.stdout.write("bot>");
  const { text } = await speakReply({
    llm,
    tts: textOnly,
    messages,
    timeline,
    ...config.reply,
    deliver: ({ text: sentence }) => process.stdout.write(` [${sentence}]`),
  });
  messages.push({ role: "assistant", content: text });
  const t = timeline.fromSpeechEnd();
  console.log(`\n     first token ${t.llm_first_token} ms, first sentence ${t.first_chunk} ms, done ${t.llm_done} ms\n`);
  if (tty) rl.prompt();
}
rl.close();
