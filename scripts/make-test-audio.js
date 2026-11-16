// Generates the caller test audio in test/audio/: each line below spoken by a Kokoro voice
// different from the assistant's, at 16 kHz, with silence before and after so the
// endpointer sees a real start and end of speech.
//
// Synthetic speech is cleaner than a real caller on a real microphone (no noise, no
// hesitation), so transcription results on it are a best case. Run once; the files are
// committed so every measurement uses the same audio.
//
//   npm run models && node scripts/make-test-audio.js

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { localTTS } from "../src/providers/tts/local.js";
import { encodeWav, toRate } from "../src/speech/pcm.js";

const OUT = fileURLToPath(new URL("../test/audio/", import.meta.url));
const LEAD_MS = 300;
const TAIL_MS = 1500;

export const UTTERANCES = [
  { id: "01-greeting", voice: "am_michael", text: "Hi, can you hear me okay?" },
  { id: "02-long-question", voice: "bf_emma", text: "My mind keeps racing when I go to bed, so it takes me ages to fall asleep. What can I do about that?" },
  { id: "03-follow-up", voice: "am_michael", text: "Can you give me just the most important one?" },
  { id: "04-numbers", voice: "af_sarah", text: "How many minutes are there in three and a half hours?" },
  { id: "05-interruption", voice: "bm_george", text: "Sorry, stop there, that's enough." },
  { id: "06-goodbye", voice: "bf_emma", text: "Thanks, that's all for today. Bye." },
];

await mkdir(OUT, { recursive: true });
const voices = new Map();
const manifest = [];
for (const { id, voice, text } of UTTERANCES) {
  if (!voices.has(voice)) voices.set(voice, await localTTS({ voice }));
  const speech = toRate(await voices.get(voice).synthesize(text), 16000);
  const lead = Math.round((LEAD_MS / 1000) * 16000);
  const tail = Math.round((TAIL_MS / 1000) * 16000);
  const samples = new Int16Array(lead + speech.samples.length + tail);
  samples.set(speech.samples, lead);
  await writeFile(`${OUT}${id}.wav`, encodeWav({ samples, sampleRate: 16000 }));
  const speechMs = Math.round((speech.samples.length / 16000) * 1000);
  manifest.push({ id, file: `${id}.wav`, voice, text, speechStartMs: LEAD_MS, speechMs });
  console.log(`${id}: ${speechMs} ms of speech (${voice})`);
}
await writeFile(`${OUT}manifest.json`, `${JSON.stringify({ generatedWith: "Kokoro-82M v1.0 (float32) via sherpa-onnx-node 2.0.1", sampleRate: 16000, leadMs: LEAD_MS, tailMs: TAIL_MS, utterances: manifest }, null, 2)}\n`);
