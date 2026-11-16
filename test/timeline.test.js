import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnTimeline } from "../src/pipeline/timeline.js";

function timelineAt(marks) {
  const timeline = new TurnTimeline({ clock: () => 0 });
  for (const [stage, at] of Object.entries(marks)) timeline.mark(stage, at);
  return timeline;
}

test("reports every stage from the end of speech", () => {
  const timeline = timelineAt({ speech_end: 1000, stt_final: 1150, llm_first_token: 1400, first_chunk: 1600 });
  assert.deepEqual(timeline.fromSpeechEnd(), {
    speech_end: 0,
    stt_final: 150,
    llm_first_token: 400,
    first_chunk: 600,
  });
});

test("breaks the critical path into consecutive stages", () => {
  const timeline = timelineAt({
    speech_end: 0,
    stt_final: 150,
    llm_first_token: 400,
    first_chunk: 600,
    llm_done: 650,
    first_audio: 800,
    first_audio_sent: 801,
  });
  assert.deepEqual(timeline.breakdown(), {
    "speech_end→stt_final": 150,
    "stt_final→llm_first_token": 250,
    "llm_first_token→first_chunk": 200,
    "first_chunk→first_audio": 200,
    "first_audio→first_audio_sent": 1,
  });
});

test("keeps the first time a stage is marked", () => {
  const timeline = timelineAt({ speech_end: 0, first_audio: 100 });
  timeline.mark("first_audio", 500);
  assert.equal(timeline.fromSpeechEnd().first_audio, 100);
});

test("rejects unknown stages and reports nothing before speech_end", () => {
  const timeline = new TurnTimeline();
  assert.throws(() => timeline.mark("tts_started"), /Unknown stage/);
  timeline.mark("stt_final");
  assert.deepEqual(timeline.fromSpeechEnd(), {});
});
