import { describe, expect, it, vi } from "vitest";
import { withIdleTimeout } from "../src/llm/idle.js";
import { StreamIdleError } from "../src/llm/types.js";

/** Async iterable emitting `events`; stalls forever after them when `stall`, else completes. */
function fakeStream(events: number[], stall: boolean) {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () =>
          i < events.length
            ? { done: false, value: events[i++] as number }
            : stall
              ? new Promise<never>(() => {})
              : { done: true, value: undefined as never },
      };
    },
  };
}

describe("withIdleTimeout", () => {
  it("passes events through while the stream is alive", async () => {
    const out: number[] = [];
    for await (const v of withIdleTimeout(fakeStream([1, 2, 3], false), 1000, () => {})) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it("aborts and throws StreamIdleError when the stream stalls", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn();
      const collected: number[] = [];
      const p = (async () => {
        for await (const v of withIdleTimeout(fakeStream([1], true), 5000, abort)) collected.push(v);
      })();
      const assertion = expect(p).rejects.toBeInstanceOf(StreamIdleError);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(collected).toEqual([1]);
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire while events keep arriving", async () => {
    vi.useFakeTimers();
    try {
      // An event every 2s, watchdog at 5s: four events, then stalls.
      let emitted = 0;
      const source = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              if (emitted >= 4) return new Promise<never>(() => {});
              emitted++;
              return { done: false, value: emitted as number };
            },
          };
        },
      };
      const collected: number[] = [];
      const p = (async () => {
        for await (const v of withIdleTimeout(source, 5000, () => {})) collected.push(v);
      })();
      const assertion = expect(p).rejects.toBeInstanceOf(StreamIdleError);
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(collected).toEqual([1, 2, 3, 4]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a pass-through when idleMs is 0", async () => {
    const out: number[] = [];
    for await (const v of withIdleTimeout(fakeStream([7], false), 0, () => {})) out.push(v);
    expect(out).toEqual([7]);
  });
});
