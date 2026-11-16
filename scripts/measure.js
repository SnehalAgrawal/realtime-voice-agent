// The recorded measurements: the scripted conversation (scripts/lib/conversation.js) under
// a baseline and one-change-at-a-time variants, each run twice, interleaved (every arm's
// first run, then every arm's second), plus word error rates per speech-to-text model.
//
//   npm run models -- --all          (the comparison models)
//   npm run measure [-- --runs 2] [-- --arms baseline,clause] [-- --out measurements/<date>]
//
// Refuses to run on battery power or while another process is connected to Ollama, unless
// --allow-battery / --allow-busy are given (for trying the script, not for recorded numbers).

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { loadProviders } from "../src/server.js";
import { Endpointer } from "../src/speech/endpointer.js";
import { decodeMuLaw, encodeMuLaw, resample } from "../src/speech/pcm.js";
import { loadTestAudio, runConversation, warmUp } from "./lib/conversation.js";

export const ARMS = [
  { id: "baseline", change: "none (500 ms silence, sentences, Moonshine base, qwen2.5:3b, Kokoro float32 on 4 threads)", env: {} },
  { id: "silence-300", change: "end of turn after 300 ms of silence", env: { VAD_SILENCE_MS: "300" } },
  { id: "silence-800", change: "end of turn after 800 ms of silence", env: { VAD_SILENCE_MS: "800" } },
  { id: "clause", change: "synthesise clauses (split at , ; : too)", env: { CHUNKING: "clause" } },
  { id: "whole", change: "synthesise the whole reply at once", env: { CHUNKING: "whole" } },
  { id: "stt-tiny", change: "Moonshine tiny for speech-to-text", env: { STT_MODEL: "moonshine-tiny-en" } },
  { id: "tts-int8", change: "Kokoro int8 for the voice", env: { TTS_MODEL: "kokoro-en-int8" } },
  { id: "llm-llama", change: "llama3.2:3b as the LLM", env: { LLM_MODEL: "llama3.2:3b" } },
  // qwen2.5:3b's first sentences rarely had a clause boundary past 24 characters, so clause
  // chunking changed nothing with it; llama3.2:3b writes longer first sentences.
  { id: "llm-llama-clause", change: "llama3.2:3b, synthesising clauses", env: { LLM_MODEL: "llama3.2:3b", CHUNKING: "clause" } },
];
const COMMON = { LLM_TEMPERATURE: "0", LLM_SEED: "42" };

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "2" },
    arms: { type: "string" },
    out: { type: "string", default: `measurements/${new Date().toISOString().slice(0, 10)}` },
    "allow-battery": { type: "boolean", default: false },
    "allow-busy": { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
});

loadEnvFile();
const arms = args.arms ? ARMS.filter((a) => args.arms.split(",").includes(a.id)) : ARMS;
const runs = Number(args.runs);
const setup = recordSetup();
if (!setup.power.includes("AC Power") && !args["allow-battery"]) fail(`Not on mains power (${setup.power}). Plug in, or pass --allow-battery for a trial run.`);
if (setup.otherOllamaClients > 0 && !args["allow-busy"]) fail("Another process is connected to Ollama. Wait for it to finish, or pass --allow-busy for a trial run.");
await mkdir(`${args.out}/runs`, { recursive: true });
console.log(`Measuring ${arms.length} arms × ${runs} runs → ${args.out}`);

const results = [];
for (let run = 1; run <= runs; run++) {
  for (const arm of arms) {
    const config = loadConfig({ ...process.env, ...COMMON, ...arm.env });
    console.log(`\n=== ${arm.id}, run ${run} (${arm.change})`);
    const providers = await loadProviders(config);
    await warmUp(providers, config.systemPrompt);
    const result = await runConversation({ config, providers, log: args.quiet ? undefined : (line) => console.log(line) });
    const record = {
      arm: arm.id,
      run,
      providers: { llm: providers.llm.name, stt: providers.stt.name, tts: providers.tts.name },
      settings: { vad: config.vad, reply: config.reply, llm: { temperature: config.llm.temperature, seed: config.llm.seed, numCtx: config.llm.numCtx, maxTokens: config.llm.maxTokens } },
      turns: result.turns,
      bargeIns: result.bargeIns,
      outOfVocabulary: result.outOfVocabulary,
      history: result.history,
    };
    results.push(record);
    await writeFile(`${args.out}/runs/${arm.id}-${run}.json`, `${JSON.stringify(record, null, 2)}\n`);
  }
}
execFileSync("ollama", ["stop", "qwen2.5:3b"], { stdio: "ignore" });
if (arms.some((a) => a.id === "llm-llama")) execFileSync("ollama", ["stop", "llama3.2:3b"], { stdio: "ignore" });

console.log("\n=== Word error rate on the test audio");
const wer = await measureWordErrorRates(arms.some((a) => a.id === "stt-tiny") ? ["moonshine-base-en", "moonshine-tiny-en"] : ["moonshine-base-en"]);

const summary = { setup, arms: arms.map((arm) => summarise(arm, results.filter((r) => r.arm === arm.id))), wer };
await writeFile(`${args.out}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(`${args.out}/summary.md`, markdown(summary));
console.log(`\n${markdown(summary)}\nWrote ${args.out}/summary.md, summary.json, and runs/`);
process.exit(0);

// --- Metrics -------------------------------------------------------------------

/** Per-stage times for one turn, from the end of the caller's speech. */
export function stages(turn) {
  const t = turn.fromSpeechEnd;
  if (!turn.endpoint || t.first_audio_sent === undefined) return null;
  const silence = turn.endpoint.silenceWaitMs;
  return {
    response: silence + t.first_audio_sent,
    silence,
    stt: t.stt_final,
    llm: t.llm_first_token - t.stt_final,
    chunk: t.first_chunk - t.llm_first_token,
    tts: t.first_audio - t.first_chunk,
    send: t.first_audio_sent - t.first_audio,
  };
}

function summarise(arm, records) {
  const rows = records.flatMap((r) => r.turns.map(stages).filter(Boolean));
  const keys = ["response", "silence", "stt", "llm", "chunk", "tts", "send"];
  const median = Object.fromEntries(keys.map((k) => [k, round(quantile(rows.map((r) => r[k]), 0.5))]));
  const range = Object.fromEntries(keys.map((k) => [k, [round(Math.min(...rows.map((r) => r[k]))), round(Math.max(...rows.map((r) => r[k])))]]));
  return {
    id: arm.id,
    change: arm.change,
    runs: records.length,
    turnsPerRun: records.map((r) => r.turns.filter((t) => t.endpoint).length),
    measuredTurns: rows.length,
    median,
    range,
    bargeIn: records.flatMap((r) => r.bargeIns.map((b) => b.speechToStopMs)),
    outcomes: records.flatMap((r) => r.turns.map((t) => t.outcome)).reduce((m, o) => ({ ...m, [o]: (m[o] ?? 0) + 1 }), {}),
    unknownWords: [...new Set(records.flatMap((r) => r.outOfVocabulary))],
    transcripts: records.map((r) => r.turns.filter((t) => t.endpoint).map((t) => t.transcript)),
  };
}

/** Word error rate of each speech-to-text model on the six test lines, at 16 kHz and as 8 kHz mu-law. */
async function measureWordErrorRates(models) {
  const { manifest, utterances } = await loadTestAudio();
  const out = [];
  for (const model of models) {
    const { stt } = await loadProviders(loadConfig({ ...process.env, STT_MODEL: model }));
    for (const quality of ["16 kHz", "8 kHz mu-law"]) {
      let errors = 0;
      let words = 0;
      const lines = [];
      for (const u of manifest.utterances) {
        let samples = utterances.get(u.id).audio.samples;
        if (quality === "8 kHz mu-law") samples = resample(decodeMuLaw(encodeMuLaw(resample(samples, 16000, 8000))), 8000, 16000);
        const endpointer = new Endpointer({ minSilenceMs: 500 });
        const segment = endpointer.accept(samples).find((e) => e.type === "speech_end");
        const { text } = await stt.transcribe(segment.audio);
        const e = editDistance(normaliseWords(u.text), normaliseWords(text));
        errors += e;
        words += normaliseWords(u.text).length;
        lines.push({ id: u.id, reference: u.text, heard: text, errors: e });
      }
      out.push({ model, quality, wer: round((errors / words) * 100), errors, words, lines });
      console.log(`${model}, ${quality}: ${errors} errors in ${words} words`);
    }
  }
  return out;
}

export function normaliseWords(text) {
  return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}

export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function quantile(values, q) {
  const sorted = [...values].sort((x, y) => x - y);
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}

function round(n) {
  return Math.round(n);
}

// --- Setup record and report ------------------------------------------------------

function recordSetup() {
  const sh = (cmd, cmdArgs) => {
    try {
      return execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim();
    } catch {
      return "unavailable";
    }
  };
  const lsof = sh("lsof", ["-nP", "-iTCP:11434", "-sTCP:ESTABLISHED"]);
  return {
    date: new Date().toISOString(),
    commit: sh("git", ["rev-parse", "--short", "HEAD"]),
    uncommittedChanges: sh("git", ["status", "--porcelain"]) !== "",
    node: process.version,
    sherpaOnnxNode: JSON.parse(execFileSync("npm", ["ls", "sherpa-onnx-node", "--json"], { encoding: "utf8" })).dependencies?.["sherpa-onnx-node"]?.version,
    ollama: sh("ollama", ["--version"]).split("\n").pop().replace(/^.*version is /, ""),
    ollamaModels: sh("ollama", ["list"]).split("\n").slice(1).map((l) => l.split(/\s+/).slice(0, 2).join(" ")),
    machine: `${sh("sysctl", ["-n", "machdep.cpu.brand_string"])}, ${Math.round(Number(sh("sysctl", ["-n", "hw.memsize"])) / 2 ** 30)} GiB`,
    os: `${sh("sw_vers", ["-productName"])} ${sh("sw_vers", ["-productVersion"])}`,
    power: sh("pmset", ["-g", "batt"]).split("\n")[0],
    loadAverage: sh("sysctl", ["-n", "vm.loadavg"]),
    otherOllamaClients: lsof === "unavailable" ? 0 : lsof.split("\n").filter((l) => l && !l.startsWith("COMMAND") && !l.startsWith("ollama")).length,
  };
}

function markdown({ setup, arms: rows, wer }) {
  const ms = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "–");
  const lines = [
    `# Measurements, ${setup.date.slice(0, 10)}`,
    "",
    `${setup.machine}, ${setup.os}; Node ${setup.node}, sherpa-onnx-node ${setup.sherpaOnnxNode}, Ollama ${setup.ollama}; ${setup.power}; commit ${setup.commit}${setup.uncommittedChanges ? " (with uncommitted changes)" : ""}.`,
    "",
    "Time from the end of the caller's speech to the first reply audio sent, in ms: the median over every answered turn of every run, with the range in brackets. Each stage column is that stage's own median, so the stages need not add up exactly to the median total.",
    "",
    "| Arm | Change | Turns measured | **Total** | Waiting for silence | Speech-to-text | First token | First sentence | Voice | Barge-in stop |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((a) =>
      `| ${a.id} | ${a.change} | ${a.measuredTurns} (${a.turnsPerRun.join(", ")} per run) | **${ms(a.median.response)}** (${ms(a.range.response[0])}–${ms(a.range.response[1])}) | ${ms(a.median.silence)} | ${ms(a.median.stt)} | ${ms(a.median.llm)} | ${ms(a.median.chunk)} | ${ms(a.median.tts)} | ${a.bargeIn.map(ms).join(", ")} |`,
    ),
    "",
    "Word error rate on the six test lines (synthetic speech, so a best case):",
    "",
    "| Model | Audio | Errors / words | WER |",
    "|---|---|---|---|",
    ...wer.map((w) => `| ${w.model} | ${w.quality} | ${w.errors} / ${w.words} | ${w.wer}% |`),
    "",
  ];
  return lines.join("\n");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
