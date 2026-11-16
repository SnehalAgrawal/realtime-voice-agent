// Delivers results strictly in the order their work was started, however long each takes.
//
// The original bot sent each sentence's audio as soon as its synthesis finished, so a
// short second sentence could be played before a long first one. Here every piece of
// work is pushed when it starts, and delivery waits for the pieces before it.
//
// cancel() is for barge-in: nothing that has not been delivered yet will be.

export class OrderedQueue {
  #tail = Promise.resolve();
  #cancelled = false;
  #deliver;
  #onError;

  /**
   * @param {(value: any, index: number) => (void | Promise<void>)} deliver
   * @param {{ onError?: (error: Error, index: number) => void }} [options]
   */
  constructor(deliver, { onError = () => {} } = {}) {
    this.#deliver = deliver;
    this.#onError = onError;
    this.pushed = 0;
    this.delivered = 0;
  }

  /** Queues a promise for in-order delivery. A rejected promise is reported and skipped. */
  push(promise) {
    const index = this.pushed++;
    // Handled below; this stops an early rejection being reported as unhandled.
    promise.catch(() => {});
    this.#tail = this.#tail.then(async () => {
      if (this.#cancelled) return;
      let value;
      try {
        value = await promise;
      } catch (error) {
        if (!this.#cancelled) this.#onError(error, index);
        return;
      }
      if (this.#cancelled) return;
      try {
        await this.#deliver(value, index);
        this.delivered++;
      } catch (error) {
        this.#onError(error, index);
      }
    });
    return index;
  }

  /** Resolves when everything pushed so far has been delivered, skipped, or cancelled. */
  drained() {
    return this.#tail;
  }

  cancel() {
    this.#cancelled = true;
  }

  get cancelled() {
    return this.#cancelled;
  }
}

/** Runs at most `limit` tasks at once; the rest wait in order. */
export function createLimiter(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid concurrency: ${limit}`);
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || waiting.length === 0) return;
    active++;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      next();
    });
}
