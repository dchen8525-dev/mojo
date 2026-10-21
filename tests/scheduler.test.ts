import { describe, expect, it } from "vitest";
import { planWaves, runWave, MAX_WAVE_CONCURRENCY } from "../src/scheduler.js";

describe("planWaves", () => {
  const safe = new Set(["read_file", "grep_files", "glob_files"]);

  it("groups consecutive parallel-safe calls into one wave", () => {
    expect(planWaves(["read_file", "grep_files", "glob_files"], (n) => safe.has(n))).toEqual([[0, 1, 2]]);
  });

  it("a mutating call breaks the wave and runs alone, in position", () => {
    expect(planWaves(["read_file", "edit_file", "grep_files", "bash", "read_file"], (n) => safe.has(n))).toEqual([
      [0],
      [1],
      [2],
      [3],
      [4],
    ]);
    expect(planWaves(["read_file", "grep_files", "edit_file"], (n) => safe.has(n))).toEqual([[0, 1], [2]]);
  });

  it("keeps the order of mixed waves after a mutating call", () => {
    expect(planWaves(["edit_file", "grep_files", "read_file"], (n) => safe.has(n))).toEqual([[0], [1, 2]]);
  });

  it("handles empty input", () => {
    expect(planWaves([], () => true)).toEqual([]);
  });
});

describe("runWave", () => {
  it("runs all tasks and respects the concurrency cap", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    const tasks = Array.from({ length: 20 }, (_, i) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      done.push(i);
    });
    await runWave(tasks, 4);
    expect(peak).toBeLessThanOrEqual(4);
    expect(done.sort((a, b) => a - b)).toHaveLength(20);
  });

  it("defaults to MAX_WAVE_CONCURRENCY", async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: MAX_WAVE_CONCURRENCY + 5 }, () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
    await runWave(tasks);
    expect(peak).toBeLessThanOrEqual(MAX_WAVE_CONCURRENCY);
  });

  it("propagates task failures after finishing queued work", async () => {
    const ran: number[] = [];
    await expect(
      runWave([
        async () => {
          ran.push(1);
        },
        async () => {
          throw new Error("boom");
        },
      ]),
    ).rejects.toThrow("boom");
    expect(ran).toContain(1);
  });
});
