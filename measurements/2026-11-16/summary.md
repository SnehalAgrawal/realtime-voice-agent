# Measurements, 2026-11-16

Apple M4 Pro, 24 GiB, macOS 26.6.2; Node v24.16.0, sherpa-onnx-node 2.0.1, Ollama 0.40.16; Now drawing from 'AC Power'; commit 4f64999.

Time from the end of the caller's speech to the first reply audio sent, in ms: the median over every answered turn of every run, with the range in brackets. Each stage column is that stage's own median, so the stages need not add up exactly to the median total.

| Arm | Change | Turns measured | **Total** | Waiting for silence | Speech-to-text | First token | First sentence | Voice | Barge-in stop |
|---|---|---|---|---|---|---|---|---|---|
| baseline | none (500 ms silence, sentences, Moonshine base, qwen2.5:3b, Kokoro float32 on 4 threads) | 12 (6, 6 per run) | **1,201** (946–1,783) | 500 | 50 | 74 | 109 | 473 | 420, 400 |
| silence-300 | end of turn after 300 ms of silence | 12 (6, 6 per run) | **986** (747–1,589) | 300 | 50 | 72 | 110 | 464 | 420, 440 |
| silence-800 | end of turn after 800 ms of silence | 12 (6, 6 per run) | **1,506** (1,247–2,078) | 800 | 51 | 75 | 112 | 471 | 440, 440 |
| clause | synthesise clauses (split at , ; : too) | 12 (6, 6 per run) | **1,199** (946–1,850) | 500 | 50 | 72 | 110 | 465 | 420, 420 |
| whole | synthesise the whole reply at once | 12 (6, 6 per run) | **1,563** (1,249–2,384) | 500 | 49 | 71 | 155 | 799 | 420, 400 |
| stt-tiny | Moonshine tiny for speech-to-text | 12 (6, 6 per run) | **1,193** (929–1,745) | 500 | 34 | 73 | 108 | 477 | 420, 420 |
| tts-int8 | Kokoro int8 for the voice | 12 (6, 6 per run) | **1,954** (1,352–3,499) | 500 | 50 | 72 | 110 | 1,230 | 420, 420 |
| llm-llama | llama3.2:3b as the LLM | 12 (6, 6 per run) | **1,520** (1,237–2,338) | 500 | 49 | 70 | 145 | 698 | 420, 420 |

Word error rate on the six test lines (synthetic speech, so a best case):

| Model | Audio | Errors / words | WER |
|---|---|---|---|
| moonshine-base-en | 16 kHz | 1 / 60 | 2% |
| moonshine-base-en | 8 kHz mu-law | 2 / 60 | 3% |
| moonshine-tiny-en | 16 kHz | 2 / 60 | 3% |
| moonshine-tiny-en | 8 kHz mu-law | 4 / 60 | 7% |
