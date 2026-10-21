import { StreamIdleError } from "./types.js";

/**
 * Fail an async iteration that stalls: if no event arrives within `idleMs`,
 * call `abort` to kill the underlying request and throw StreamIdleError.
 * `idleMs <= 0` passes the source through unchanged (watchdog disabled).
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  abort: () => void,
): AsyncGenerator<T, void, undefined> {
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    yield* source;
    return;
  }
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let next: IteratorResult<T>;
      try {
        next = await Promise.race([
          it.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort();
              reject(new StreamIdleError(idleMs));
            }, idleMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Ensure the underlying request is torn down even when we throw mid-iteration.
    await it.return?.(undefined).catch(() => {});
  }
}
