/**
 * Minimal async coordination primitives (no dependencies). Both are single-
 * threaded and safe against Node's microtask interleaving: they never busy-
 * wait, and a rejected task still releases its slot.
 */

/** A promise-based mutex. `runExclusive` queues callers FIFO and never overlaps. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** Serialize `fn` behind every prior `runExclusive` call. Returns fn's result. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    // Keep the chain alive even if fn rejects, so later callers aren't poisoned.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * A counting semaphore bounding how many tasks run at once. `acquire` resolves
 * when a slot frees; the returned release must be called exactly once.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    this.available = Math.max(1, capacity);
  }

  acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.available--;
        resolve(this.makeRelease());
      });
    });
  }

  private makeRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.available++;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
