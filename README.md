# Real-time voice agent

A voice agent that listens, thinks, and speaks in real time: speech-to-text, an LLM, and text-to-speech, streamed over WebSockets. It's the public companion to the [Real-Time AI Voice Agents](https://snehalagrawal.com/work/real-time-ai-voice-agents/) case study, and is designed to show how response time is measured, stage by stage, and what moves it.

> **Status: being rebuilt.** This branch replaces the original Plivo + Google + OpenAI + Azure bot, which needed four accounts to run, with a pipeline that runs locally with **no accounts and no API keys**. Cloud providers stay available: each stage can be pointed at any provider with an API key. The plan, in order:
>
> 1. **Foundation** (done): the reply pipeline, ordered playback, a per-turn timeline, provider interfaces, LLM providers, and tests.
> 2. Local speech: voice activity detection, speech-to-text, and text-to-speech; barge-in.
> 3. A browser client: talk to it from a laptop microphone.
> 4. The phone path: Plivo Media Streams, tested against a simulated call.
> 5. Measurements: latency per stage on recorded test audio, and what changes it.

## What works now

- **The reply pipeline** ([`src/pipeline/reply.js`](src/pipeline/reply.js)): streams the model's tokens, cuts them into sentences as they arrive ([`sentence-chunker.js`](src/pipeline/sentence-chunker.js)), synthesises each sentence as soon as it's complete, and delivers the audio **strictly in order** ([`ordered-queue.js`](src/pipeline/ordered-queue.js)). Aborting it, which is what barge-in will do, stops generation, synthesis, and delivery, and reports which sentences were delivered.
- **A per-turn timeline** ([`timeline.js`](src/pipeline/timeline.js)): timestamps on one monotonic clock for end of speech, transcript ready, first token, first sentence, first audio, and first audio sent, so the latency of each stage can be reported.
- **LLM providers:** [Ollama](src/providers/llm/ollama.js) (the local default) and [any OpenAI-compatible API](src/providers/llm/openai-compatible.js). Both are plain `fetch` calls with no SDKs.
- **A terminal chat** through the same pipeline, without the speech stages.

## Run it

Requires Node.js 24 or newer, and [Ollama](https://ollama.com) with a model pulled:

```bash
ollama pull qwen2.5:3b
npm install
npm run chat          # type a message; an empty line ends the chat
npm run check         # lint and tests
```

`npm test` needs no model and no network: the providers are tested against a local mock server.

## Configuration

Everything is set by environment variables, or a `.env` file (see [`.env.example`](.env.example)). With none set, everything runs locally.

To use a hosted model instead, point the LLM at any OpenAI-compatible endpoint:

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=your-key
```

Ollama is called through its native API, not its OpenAI-compatible one, because only the native API accepts the context length (`LLM_NUM_CTX`). Without it, a long conversation is cut to the server's default context without an error.

## The bug this rebuild fixes first: audio out of order

The original bot started synthesising each sentence as soon as the model finished it, which was right. But it also sent each sentence's audio as soon as that sentence's synthesis finished. Synthesis takes longer for longer text, so a long first sentence followed by a short second one was played second-then-first.

[`scripts/reproduce-original-ordering-bug.cjs`](scripts/reproduce-original-ordering-bug.cjs) runs the original `src/action.js` from commit `f1b77c0` unchanged, with its LLM and TTS replaced by fakes:

```text
LLM order:  "Sure, I can book that appointment for you on Tuesday morning at the downtown clinic." -> "Anything else today?"
sent order: "Anything else today?" -> "Sure, I can book that appointment for you on Tuesday morning at the downtown clinic."
OUT OF ORDER (bug reproduced)
```

Now each sentence's synthesis is queued in order the moment it starts, and delivery waits for the sentences before it. Synthesis of later sentences still overlaps playback of earlier ones. The same scenario is the regression test in [`test/ordering.test.js`](test/ordering.test.js), next to a test showing that sending on completion reorders it.

## Licence

[MIT](LICENSE).
