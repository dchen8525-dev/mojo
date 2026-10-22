import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_CRON_TASKS,
  claimDueTasks,
  createCronTask,
  cronFilePath,
  deleteCronTask,
  finishCronRun,
  formatCronTask,
  loadCronTasks,
  nextCronTime,
  parseCron,
  recoverStaleRuns,
  startCronRun,
  updateCronTask,
  validateCron,
  type CronTask,
} from "../src/cron.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cron-store-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function writeTasks(tasks: CronTask[]): Promise<void> {
  await fs.mkdir(path.join(home, ".node-agent"), { recursive: true });
  await fs.writeFile(cronFilePath(home), JSON.stringify({ tasks }, null, 2), "utf8");
}

function task(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: "cr_test0001",
    name: "test",
    cron: "*/5 * * * *",
    prompt: "do something",
    cwd: process.cwd(),
    enabled: true,
    createdAt: new Date(0).toISOString(),
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("cron expression parsing", () => {
  it("accepts the supported syntax", () => {
    for (const expr of [
      "* * * * *",
      "*/5 * * * *",
      "0 9-17 * * 1-5",
      "0,30 8,20 * * 0,6",
      "15 3 1 1 *",
      "5/10 * * * *",
      "0 0 * * 7",
    ]) {
      expect(validateCron(expr), expr).toEqual({ ok: true });
    }
  });

  it("rejects malformed expressions with a clear message", () => {
    const bad: Array<[string, RegExp]> = [
      ["* * * *", /5 fields/],
      ["60 * * * *", /minute value 60/],
      ["* 24 * * *", /hour value 24/],
      ["* * 0 * *", /day-of-month value 0/],
      ["* * * 13 *", /month value 13/],
      ["* * * * 8", /day-of-week value 8/],
      ["10-5 * * * *", /reversed/],
      ["*/0 * * * *", /step/],
      ["1,,2 * * * *", /empty/],
      ["a * * * *", /numbers only/],
    ];
    for (const [expr, pattern] of bad) {
      const r = validateCron(expr);
      expect(r.ok, expr).toBe(false);
      if (!r.ok) expect(r.error).toMatch(pattern);
    }
  });

  it("treats 7 as Sunday", () => {
    const from = new Date(2026, 9, 22, 10, 7, 30); // Thursday
    const sunday = nextCronTime("0 9 * * 7", from);
    const zero = nextCronTime("0 9 * * 0", from);
    expect(sunday.getTime()).toBe(zero.getTime());
    expect(sunday.getDay()).toBe(0);
  });
});

describe("nextCronTime", () => {
  const from = new Date(2026, 9, 22, 10, 7, 30); // Thursday 2026-10-22 10:07:30

  it("advances to the next matching minute", () => {
    expect(nextCronTime("*/15 * * * *", from)).toEqual(new Date(2026, 9, 22, 10, 15, 0, 0));
  });

  it("rolls over to the next day", () => {
    expect(nextCronTime("0 9 * * *", from)).toEqual(new Date(2026, 9, 23, 9, 0, 0, 0));
  });

  it("handles weekdays", () => {
    expect(nextCronTime("0 9 * * 1", from)).toEqual(new Date(2026, 9, 26, 9, 0, 0, 0));
  });

  it("matches either day field when both are restricted", () => {
    // Oct 26 is Monday (weekday match), Nov 1 is the 1st (day-of-month match).
    expect(nextCronTime("0 0 1 * 1", from)).toEqual(new Date(2026, 9, 26, 0, 0, 0, 0));
    expect(nextCronTime("0 0 1 * *", from)).toEqual(new Date(2026, 10, 1, 0, 0, 0, 0));
  });

  it("finds Feb 29 across years", () => {
    expect(nextCronTime("0 0 29 2 *", from)).toEqual(new Date(2028, 1, 29, 0, 0, 0, 0));
  });

  it("throws when the expression can never fire", () => {
    expect(() => nextCronTime("0 0 30 2 *", from)).toThrow(/never fires/);
  });

  it("is strictly after the given time", () => {
    const exact = new Date(2026, 9, 22, 10, 15, 0, 0);
    expect(nextCronTime("*/15 * * * *", exact)).toEqual(new Date(2026, 9, 22, 10, 30, 0, 0));
  });

  it("parses step lists and ranges", () => {
    const spec = parseCron("5/20 8-10 * * *");
    expect([...spec.minutes]).toEqual([5, 25, 45]);
    expect([...spec.hours]).toEqual([8, 9, 10]);
  });
});

describe("cron task store", () => {
  it("creates, loads, updates and deletes tasks", async () => {
    const created = await createCronTask({ cron: "0 9 * * *", prompt: "summarize the repo", cwd: process.cwd() }, home);
    expect(created.id).toMatch(/^cr_[0-9a-f]{8}$/);
    expect(created.name).toBe("summarize the repo");
    expect(created.enabled).toBe(true);
    expect(new Date(created.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 1000);

    const loaded = await loadCronTasks(home);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(created.id);

    const updated = await updateCronTask(created.id, { name: "daily", cron: "30 6 * * *", enabled: false }, home);
    expect(updated.name).toBe("daily");
    expect(updated.enabled).toBe(false);
    expect(updated.cron).toBe("30 6 * * *");

    // Re-enabling recomputes the next fire time from now.
    const enabled = await updateCronTask(created.id, { enabled: true }, home);
    expect(enabled.enabled).toBe(true);
    expect(new Date(enabled.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 1000);

    expect(await deleteCronTask(created.id, home)).toBe(true);
    expect(await deleteCronTask(created.id, home)).toBe(false);
    expect(await loadCronTasks(home)).toHaveLength(0);
  });

  it("validates input", async () => {
    await expect(createCronTask({ cron: "bad", prompt: "x", cwd: process.cwd() }, home)).rejects.toThrow(/5 fields/);
    await expect(createCronTask({ cron: "* * * * *", prompt: "  ", cwd: process.cwd() }, home)).rejects.toThrow(/prompt/);
    await expect(createCronTask({ cron: "* * * * *", prompt: "x", cwd: "relative/dir" }, home)).rejects.toThrow(/absolute/);
    await expect(createCronTask({ cron: "* * * * *", prompt: "x", cwd: path.join(home, "missing") }, home)).rejects.toThrow(
      /not a directory/,
    );
    const fileAsDir = path.join(home, "not-a-dir");
    await fs.writeFile(fileAsDir, "x");
    await expect(createCronTask({ cron: "* * * * *", prompt: "x", cwd: fileAsDir }, home)).rejects.toThrow(/not a directory/);
  });

  it("validates a changed working directory but still toggles a vanished one", async () => {
    const created = await createCronTask({ cron: "0 9 * * *", prompt: "x", cwd: home }, home);
    await expect(updateCronTask(created.id, { cwd: path.join(home, "gone") }, home)).rejects.toThrow(/not a directory/);

    // A task whose directory disappeared after creation must stay editable.
    const legacy = task({ id: "cr_legacy01", cwd: path.join(home, "gone") });
    await writeTasks([legacy]);
    await expect(updateCronTask(legacy.id, { enabled: false }, home)).resolves.toMatchObject({ enabled: false });
  });

  it("caps the number of tasks", async () => {
    const tasks = Array.from({ length: MAX_CRON_TASKS }, (_, i) => task({ id: `cr_${i.toString(16).padStart(8, "0")}` }));
    await writeTasks(tasks);
    await expect(createCronTask({ cron: "* * * * *", prompt: "x", cwd: process.cwd() }, home)).rejects.toThrow(/at most/);
  });

  it("refuses to overwrite a corrupt ledger", async () => {
    await fs.mkdir(path.join(home, ".node-agent"), { recursive: true });
    await fs.writeFile(cronFilePath(home), "{not json", "utf8");
    await expect(loadCronTasks(home)).rejects.toThrow(/not valid JSON/);
    await expect(createCronTask({ cron: "* * * * *", prompt: "x", cwd: process.cwd() }, home)).rejects.toThrow(/not valid JSON/);
  });

  it("claims due tasks, advances the schedule and records completion", async () => {
    await writeTasks([task()]);
    const now = new Date();
    const claimed = await claimDueTasks(now, home);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].lastStatus).toBe("running");
    expect(claimed[0].runCount).toBe(1);
    expect(new Date(claimed[0].nextRunAt).getTime()).toBeGreaterThan(now.getTime());

    // A running task is not claimed again even if another slot passes.
    expect(await claimDueTasks(new Date(now.getTime() + 3600_000), home)).toHaveLength(0);

    await finishCronRun(claimed[0].id, { ok: false, error: "boom", log: "/tmp/x.log" }, home);
    const [done] = await loadCronTasks(home);
    expect(done.lastStatus).toBe("error");
    expect(done.lastError).toBe("boom");
    expect(done.lastLog).toBe("/tmp/x.log");
    expect(done.runStartedAt).toBeUndefined();
  });

  it("disables a due task whose stored expression became invalid", async () => {
    await writeTasks([task({ cron: "broken" })]);
    const claimed = await claimDueTasks(new Date(), home);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].enabled).toBe(false);
    expect(claimed[0].lastStatus).toBe("error");
    expect(claimed[0].lastError).toMatch(/5 fields/);
    expect(claimed[0].lastRunAt).toBeUndefined();
    expect(claimed[0].runCount).toBe(0);
  });

  it("disables a due task whose nextRunAt is corrupt instead of wedging it", async () => {
    await writeTasks([task({ nextRunAt: "not-a-date" })]);
    const claimed = await claimDueTasks(new Date(), home);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].enabled).toBe(false);
    expect(claimed[0].lastStatus).toBe("error");
    expect(claimed[0].lastError).toMatch(/invalid nextRunAt/);
    expect(claimed[0].runCount).toBe(0);
    expect(await claimDueTasks(new Date(), home)).toHaveLength(0);
  });

  it("manual start leaves nextRunAt untouched", async () => {
    await writeTasks([task({ nextRunAt: new Date(Date.now() + 3600_000).toISOString() })]);
    const before = (await loadCronTasks(home))[0].nextRunAt;
    const started = await startCronRun("cr_test0001", new Date(), home);
    expect(started?.lastStatus).toBe("running");
    expect(started?.nextRunAt).toBe(before);
    expect(started?.runCount).toBe(1);
    expect(await startCronRun("nope", new Date(), home)).toBeNull();
  });

  it("reaps runs left running by a dead scheduler", async () => {
    const stale = task({ lastStatus: "running", runStartedAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
    await writeTasks([stale]);
    expect(await recoverStaleRuns(home)).toBe(1);
    const [recovered] = await loadCronTasks(home);
    expect(recovered.lastStatus).toBe("error");
    expect(recovered.lastError).toMatch(/interrupted/);
  });

  it("keeps recent running tasks while the owner is still alive", async () => {
    const fresh = task({ lastStatus: "running", runStartedAt: new Date().toISOString() });
    await writeTasks([fresh]);
    expect(await recoverStaleRuns(home)).toBe(0);
    expect((await loadCronTasks(home))[0].lastStatus).toBe("running");
  });

  it("formats a task for listings", async () => {
    const [created] = [await createCronTask({ cron: "0 9 * * *", prompt: "x", cwd: process.cwd() }, home)];
    const line = formatCronTask(created);
    expect(line).toContain(created.id);
    expect(line).toContain("0 9 * * *");
    expect(line).toContain("next");
  });
});
