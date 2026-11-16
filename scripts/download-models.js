// Downloads the local speech models into models/ and verifies each file's SHA-256.
//
//   npm run models                 the defaults (about 235 MB)
//   npm run models -- --all        also the comparison models used by the measurements
//   npm run models -- moonshine-tiny-en
//
// All files come from the sherpa-onnx GitHub releases; checksums are the ones GitHub
// publishes for each release asset.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { MODELS, MODELS_DIR } from "../src/speech/models.js";

const args = process.argv.slice(2);
const wanted = args.includes("--all")
  ? Object.keys(MODELS)
  : args.filter((a) => !a.startsWith("--")).length
    ? args.filter((a) => !a.startsWith("--"))
    : Object.keys(MODELS).filter((name) => MODELS[name].default);

for (const name of wanted) {
  if (!MODELS[name]) {
    console.error(`Unknown model "${name}". Known: ${Object.keys(MODELS).join(", ")}`);
    process.exit(1);
  }
}

await mkdir(MODELS_DIR, { recursive: true });
for (const name of wanted) await download(name, MODELS[name]);

async function download(name, model) {
  const target = join(MODELS_DIR, model.path);
  if (existsSync(target)) {
    console.log(`${name}: already present (${model.path})`);
    return;
  }
  const file = model.url.split("/").pop();
  const partial = join(MODELS_DIR, `${file}.partial`);
  console.log(`${name}: downloading ${file} (${model.sizeMB} MB) ...`);
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`${name}: ${response.status} ${response.statusText} for ${model.url}`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => hash.update(chunk));
  await pipeline(body, createWriteStream(partial));
  const digest = hash.digest("hex");
  if (digest !== model.sha256) {
    await rm(partial);
    throw new Error(`${name}: checksum mismatch (expected ${model.sha256}, got ${digest}); file removed`);
  }
  if (file.endsWith(".tar.bz2")) {
    execFileSync("tar", ["-xjf", partial, "-C", MODELS_DIR]);
    await rm(partial);
  } else {
    await rename(partial, target);
  }
  if (!existsSync(target)) throw new Error(`${name}: expected ${model.path} after download`);
  console.log(`${name}: ok, sha256 verified`);
}
