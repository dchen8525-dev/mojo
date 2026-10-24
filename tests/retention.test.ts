import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRetention, retentionDays, scheduleRetentionCleanup } from "../src/retention.js";

let home = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "retention-"));
  await fs.mkdir(path.join(home, ".node-agent", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".node-agent", "journal"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { force: true, recursive: true });
});

async function seed(dir: "sessions" | "journal", name: string, ageDays: number): Promise<string> {
  const full = path.join(home, ".node-agent", dir, name);
  await fs.writeFile(full, "{}\n");
  const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  await fs.utimes(full, t, t);
  return full;
}

describe("retentionDays", () => {
  it("defaults to 14 days and accepts 0 to disable", () => {
    expect(retentionDays()).toBe(14);
    expect(retentionDays(undefined)).toBe(14);
    expect(retentionDays("0")).toBe(0);
    expect(retentionDays("7")).toBe(7);
    expect(retentionDays("2.9")).toBe(2);
    expect(retentionDays("-3")).toBe(14);
    expect(retentionDays("junk")).toBe(14);
    expect(retentionDays("")).toBe(14);
  });
});

describe("cleanupRetention", () => {
  it("deletes sessions and journal files older than the window, keeps fresh ones", async () => {
    const oldSession = await seed("sessions", "aaaa1111.jsonl", 20);
    const freshSession = await seed("sessions", "bbbb2222.jsonl", 1);
    const oldJournal = await seed("journal", "cccc3333.jsonl", 30);
    const freshJournal = await seed("journal", "dddd4444.jsonl", 2);

    const result = await cleanupRetention({ home, now: new Date() });

    expect(result.deletedFiles.sort()).toEqual(["aaaa1111.jsonl", "cccc3333.jsonl"]);
    expect(result.failedFiles).toEqual([]);
    expect(result.scannedFiles).toBe(4);
    await expect(fs.stat(oldSession)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(oldJournal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(freshSession)).resolves.toBeTruthy();
    await expect(fs.stat(freshJournal)).resolves.toBeTruthy();
  });

  it("never deletes the kept session id (raw or journal-sanitized)", async () => {
    const kept = await seed("sessions", "deadbeef.jsonl", 30);
    const keptJournal = await seed("journal", "deadbeef.jsonl", 30);
    const keptSanitized = await seed("journal", "a_b_c.jsonl", 30);
    const keptCase = await seed("journal", "Sess_One.jsonl", 30);
    const doomed = await seed("sessions", "other.jsonl", 30);

    const result = await cleanupRetention({
      home,
      keepIds: ["deadbeef", "a b c", "Sess:One"],
      now: new Date(),
    });

    expect(result.deletedFiles).toEqual(["other.jsonl"]);
    await expect(fs.stat(kept)).resolves.toBeTruthy();
    await expect(fs.stat(keptJournal)).resolves.toBeTruthy();
    await expect(fs.stat(keptSanitized)).resolves.toBeTruthy();
    await expect(fs.stat(keptCase)).resolves.toBeTruthy();
  });

  it("does not delete a file that was refreshed between the ownership check and unlink", async () => {
    const resumed = await seed("sessions", "resumed.jsonl", 30);
    let calls = 0;
    const statSpy = vi.spyOn(fs, "lstat").mockImplementation((async () => {
      calls += 1;
      // Old on first look, freshly appended by another process on re-check.
      return { isFile: () => true, mtimeMs: calls === 1 ? 0 : Date.now() } as never;
    }) as never);
    try {
      const result = await cleanupRetention({ home, now: new Date() });
      expect(result.deletedFiles).toEqual([]);
    } finally {
      statSpy.mockRestore();
    }
    await expect(fs.stat(resumed)).resolves.toBeTruthy();
  });

  it("respects retentionDays override and disables at 0", async () => {
    const tenDays = await seed("sessions", "aaaa1111.jsonl", 10);
    await cleanupRetention({ home, retentionDays: 7, now: new Date() });
    await expect(fs.stat(tenDays)).rejects.toMatchObject({ code: "ENOENT" });

    const ninetyDays = await seed("sessions", "bbbb2222.jsonl", 90);
    const result = await cleanupRetention({ home, retentionDays: 0, now: new Date() });
    expect(result.deletedFiles).toEqual([]);
    expect(result.scannedFiles).toBe(0);
    await expect(fs.stat(ninetyDays)).resolves.toBeTruthy();
  });

  it("ignores non-jsonl files and missing directories", async () => {
    await seed("sessions", "notes.txt", 90);
    await fs.mkdir(path.join(home, ".node-agent", "empty"), { recursive: true });
    const result = await cleanupRetention({ home, now: new Date() });
    expect(result.scannedFiles).toBe(0);
    expect(result.deletedFiles).toEqual([]);
  });

  it("honors AGENT_RETENTION_DAYS via envRetentionDays", async () => {
    const old = await seed("sessions", "aaaa1111.jsonl", 20);
    await cleanupRetention({ home, envRetentionDays: "0", now: new Date() });
    await expect(fs.stat(old)).resolves.toBeTruthy();
    await cleanupRetention({ home, envRetentionDays: "7", now: new Date() });
    await expect(fs.stat(old)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("scheduleRetentionCleanup", () => {
  it("runs cleanup after the delay with the given keep ids", async () => {
    const doomed = await seed("sessions", "aaaa1111.jsonl", 30);
    let fired: (() => void) | undefined;
    const timers: Array<{ unref?(): void }> = [];
    const timer = scheduleRetentionCleanup({
      home,
      keepIds: ["keepme"],
      delayMs: 5,
      setTimeout: (cb, ms) => {
        expect(ms).toBe(5);
        fired = cb;
        const t = { unref() {} };
        timers.push(t);
        return t;
      },
    });
    timer.unref?.();
    expect(fired).toBeTypeOf("function");
    fired?.();
    await expect
      .poll(async () => fs.stat(doomed).then(() => false, () => true))
      .toBe(true);
  });

  it("evaluates a keepIds function when cleanup fires, not when scheduled", async () => {
    const kept = await seed("sessions", "aaaa1111.jsonl", 30);
    const doomed = await seed("sessions", "zzzz9999.jsonl", 30);
    let current: string[] = [];
    let fired: (() => void) | undefined;
    scheduleRetentionCleanup({
      home,
      keepIds: () => current,
      delayMs: 5,
      setTimeout: (cb) => {
        fired = cb;
        return { unref() {} };
      },
    });
    // The host (GUI) opens an old session after scheduling, before the timer.
    current = ["aaaa1111"];
    fired?.();
    await expect.poll(async () => fs.stat(doomed).then(() => false, () => true)).toBe(true);
    await expect(fs.stat(kept)).resolves.toBeTruthy();
  });
});
