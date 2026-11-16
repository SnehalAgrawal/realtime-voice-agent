import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderedQueue, createLimiter } from "../src/pipeline/ordered-queue.js";
import { sleep } from "./helpers.js";

const after = (ms, value) => sleep(ms).then(() => value);

test("delivers in push order regardless of which promise settles first", async () => {
  const out = [];
  const queue = new OrderedQueue((value) => out.push(value));
  queue.push(after(30, "a"));
  queue.push(after(1, "b"));
  queue.push(after(15, "c"));
  await queue.drained();
  assert.deepEqual(out, ["a", "b", "c"]);
  assert.equal(queue.delivered, 3);
});

test("waits for each delivery before starting the next", async () => {
  const events = [];
  const queue = new OrderedQueue(async (value) => {
    events.push(`start ${value}`);
    await sleep(10);
    events.push(`end ${value}`);
  });
  queue.push(Promise.resolve(1));
  queue.push(Promise.resolve(2));
  await queue.drained();
  assert.deepEqual(events, ["start 1", "end 1", "start 2", "end 2"]);
});

test("reports a failed piece and carries on with the next", async () => {
  const out = [];
  const errors = [];
  const queue = new OrderedQueue((value) => out.push(value), {
    onError: (error, index) => errors.push([error.message, index]),
  });
  queue.push(after(5, "a"));
  queue.push(Promise.reject(new Error("synthesis failed")));
  queue.push(after(1, "c"));
  await queue.drained();
  assert.deepEqual(out, ["a", "c"]);
  assert.deepEqual(errors, [["synthesis failed", 1]]);
});

test("cancel() stops everything not yet delivered", async () => {
  const out = [];
  const queue = new OrderedQueue((value) => out.push(value));
  queue.push(after(1, "a"));
  queue.push(after(20, "b"));
  queue.push(after(1, "c"));
  await sleep(10);
  queue.cancel();
  await queue.drained();
  assert.deepEqual(out, ["a"]);
  assert.equal(queue.cancelled, true);
});

test("createLimiter runs at most `limit` tasks at once, in order", async () => {
  const limit = createLimiter(2);
  let active = 0;
  let maxActive = 0;
  const started = [];
  const task = (id) => async () => {
    started.push(id);
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(10);
    active--;
    return id;
  };
  const results = await Promise.all([1, 2, 3, 4, 5].map((id) => limit(task(id))));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2);
});

test("createLimiter rejects an invalid limit", () => {
  assert.throws(() => createLimiter(0), /Invalid concurrency/);
});
