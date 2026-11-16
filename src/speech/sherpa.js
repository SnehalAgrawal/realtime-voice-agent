// Loads sherpa-onnx (a CommonJS native addon) only when a local speech model is used,
// so a configuration that uses only hosted providers never loads it.

import { createRequire } from "node:module";

let sherpa;

export function loadSherpa() {
  sherpa ??= createRequire(import.meta.url)("sherpa-onnx-node");
  return sherpa;
}
