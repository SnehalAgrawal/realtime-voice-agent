# Measurements, 2026-11-16

Apple M4 Pro, 24 GiB, macOS 26.6.2; Node v24.16.0, sherpa-onnx-node 2.0.1, Ollama 0.40.16; Now drawing from 'AC Power'; commit 4f64999 (with uncommitted changes).

Time from the end of the caller's speech to the first reply audio sent, in ms: the median over every answered turn of every run, with the range in brackets. Each stage column is that stage's own median, so the stages need not add up exactly to the median total.

| Arm | Change | Turns measured | **Total** | Waiting for silence | Speech-to-text | First token | First sentence | Voice | Barge-in stop |
|---|---|---|---|---|---|---|---|---|---|
| llm-llama | llama3.2:3b as the LLM | 12 (6, 6 per run) | **1,491** (1,221–2,347) | 500 | 47 | 70 | 145 | 714 | 420, 400 |
| llm-llama-clause | llama3.2:3b, synthesising clauses | 12 (6, 6 per run) | **1,252** (1,058–1,655) | 500 | 49 | 71 | 115 | 542 | 420, 440 |

Word error rate on the six test lines (synthetic speech, so a best case):

| Model | Audio | Errors / words | WER |
|---|---|---|---|
| moonshine-base-en | 16 kHz | 1 / 60 | 2% |
| moonshine-base-en | 8 kHz mu-law | 2 / 60 | 3% |
