import { describe, expect, it } from "vitest";
import { Mutex, Semaphore } from "../src/sync.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("Mutex", () => {
  it("never overlaps critical sections", async () => {
    const m = new Mutex();
    const events: string[] = [];
    const section = (name: string) =>
      m.runExclusive(async () => {
        events.push(`enter ${name}`);
        await tick();
        events.push(`exit ${name}`);
        return name;
      });

    const results = await Promise.all([section("a"), section("b"), section("c")]);
    expect(results).toEqual(["a", "b", "c"]);
    // Strict non-interleaving: each exit precedes the next enter.
    expect(events).toEqual(["enter a", "exit a", "enter b", "exit b", "enter c", "exit c"]);
  });

  it("a rejection does not poison later callers", async () => {
    const m = new Mutex();
    await expect(m.runExclusive(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await m.runExclusive(async () => "ok")).toBe("ok");
  });
});

describe("Semaphore", () => {
  it("caps concurrent holders at capacity", async () => {
    const s = new Semaphore(2);
    let live = 0;
    let peak = 0;
    const job = async () => {
      const release = await s.acquire();
      live++;
      peak = Math.max(peak, live);
      await tick();
      live--;
      release();
    };
    await Promise.all(Array.from({ length: 6 }, job));
    expect(peak).toBe(2);
    expect(live).toBe(0);
  });

  it("releases free slots for queued waiters in order", async () => {
    const s = new Semaphore(1);
    const order: number[] = [];
    const job = async (n: number) => {
      const release = await s.acquire();
      order.push(n);
      await tick();
      release();
    };
    await Promise.all([job(1), job(2), job(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("double release is ignored", async () => {
    const s = new Semaphore(1);
    const release = await s.acquire();
    release();
    release(); // no-op
    const again = await s.acquire(); // still exactly one slot
    expect(again).toBeTypeOf("function");
  });
});
