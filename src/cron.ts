import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteFile } from "./atomicWrite.js";

/**
 * Persistent scheduled tasks, ZCode-style: a plain JSON ledger of definitions
 * that any agent process may edit, owned by whichever process holds the
 * scheduler lease (see cronScheduler.ts).
 *
 * Expressions are the classic five-field form in *local* time:
 *   minute hour day-of-month month day-of-week
 * Supporting `*`, `a`, `a-b`, `a-b/n`, a wildcard with a step, `a/n`, and
 * comma lists. Names (`MON`, `JAN`) are not supported. Day-of-week accepts
 * 0-7 (0 and 7 = Sunday).
 */

export interface CronTask {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  /** Working directory the spawned agent runs in. Always absolute. */
  cwd: string;
  enabled: boolean;
  createdAt: string;
  /** Next scheduled fire time (ISO). Advanced when a task is claimed. */
  nextRunAt: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error" | "running";
  lastError?: string;
  /** Path of the most recent run log under ~/.node-agent/cron-runs. */
  lastLog?: string;
  /** When the current/last run started (ISO); used to reap interrupted runs. */
  runStartedAt?: string;
  runCount: number;
}

export interface CronTaskInput {
  name?: string;
  cron: string;
  prompt: string;
  cwd: string;
  enabled?: boolean;
}

export interface CronTaskPatch {
  name?: string;
  cron?: string;
  prompt?: string;
  cwd?: string;
  enabled?: boolean;
}

export const MAX_CRON_TASKS = 50;
const NAME_MAX = 60;
const PROMPT_MAX = 8000;
const STALE_RUN_MS = 2 * 60 * 60 * 1000;
const INTERRUPTED_ERROR = "run interrupted (the scheduler process exited or was killed)";

export function cronDir(home = os.homedir()): string {
  return path.join(home, ".node-agent");
}

export function cronFilePath(home = os.homedir()): string {
  return path.join(cronDir(home), "cron.json");
}

export function cronRunsDir(home = os.homedir()): string {
  return path.join(cronDir(home), "cron-runs");
}

interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface ParsedField {
  values: number[];
  /** True for a bare wildcard or a wildcard with a step — cron's day-matching rule keys off this. */
  unrestricted: boolean;
}

function parseNumber(raw: string, min: number, max: number, field: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`invalid ${field} value "${raw}" (numbers only)`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${field} value ${n} is outside ${min}-${max}`);
  return n;
}

/** Parse one comma-separated cron field into its allowed values. */
function parseField(raw: string, min: number, max: number, field: string): ParsedField {
  const values = new Set<number>();
  let unrestricted = false;
  for (const part of raw.split(",")) {
    if (!part) throw new Error(`empty ${field} field segment`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`invalid ${field} segment "${part}"`);
    const step = stepPart === undefined ? 1 : parseNumber(stepPart, 1, max, `${field} step`);

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
      if (step === 1) unrestricted = true;
    } else if (rangePart.includes("-")) {
      const [a, b, rest] = rangePart.split("-");
      if (rest !== undefined || !a || !b) throw new Error(`invalid ${field} range "${rangePart}"`);
      lo = parseNumber(a, min, max, field);
      hi = parseNumber(b, min, max, field);
      if (lo > hi) throw new Error(`${field} range "${rangePart}" is reversed`);
    } else {
      lo = parseNumber(rangePart, min, max, field);
      // `a/n` means a..max step n (cronie behavior).
      hi = stepPart === undefined ? lo : max;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values: [...values].sort((a, b) => a - b), unrestricted };
}

/** Exported for tests; throws a user-facing message on bad input. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields (minute hour day month weekday), got ${fields.length}`);
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields;
  const minutes = parseField(minuteRaw, 0, 59, "minute");
  const hours = parseField(hourRaw, 0, 23, "hour");
  const doms = parseField(domRaw, 1, 31, "day-of-month");
  const months = parseField(monthRaw, 1, 12, "month");
  const dows = parseField(dowRaw, 0, 7, "day-of-week");
  const dowValues = new Set<number>();
  for (const d of dows.values) dowValues.add(d === 7 ? 0 : d);
  return {
    minutes: new Set(minutes.values),
    hours: new Set(hours.values),
    doms: new Set(doms.values),
    months: new Set(months.values),
    dows: dowValues,
    domRestricted: !domRaw.startsWith("*"),
    dowRestricted: !dowRaw.startsWith("*"),
  };
}

export function validateCron(expr: string): { ok: true } | { ok: false; error: string } {
  try {
    parseCron(expr);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  const domOk = spec.doms.has(date.getDate());
  const dowOk = spec.dows.has(date.getDay());
  // Classic cron: when both day fields are restricted, either may match.
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/**
 * The first matching time strictly after `from` (seconds truncated). Throws
 * when the expression can never fire (e.g. `0 0 30 2 *`).
 */
export function nextCronTime(expr: string, from: Date = new Date()): Date {
  const spec = parseCron(expr);
  // Truncate and advance by absolute time. Wall-clock arithmetic (setSeconds
  // / setMinutes) re-resolves an ambiguous time to the earlier DST offset,
  // which can move the scan start one hour backwards during a fall-back.
  const start = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);

  // 12 years covers Feb 29 in the worst case (a leap year skipped by century rules).
  const maxDays = 366 * 12;
  for (let d = 0; d < maxDays; d++) {
    const day = new Date(start.getTime());
    day.setDate(start.getDate() + d);
    if (d > 0) day.setHours(0, 0, 0, 0);
    if (!spec.months.has(day.getMonth() + 1)) continue;
    if (!dayMatches(spec, day)) continue;
    const startHour = d === 0 ? start.getHours() : 0;
    const startMinute = d === 0 ? start.getMinutes() : 0;
    for (let h = startHour; h < 24; h++) {
      if (!spec.hours.has(h)) continue;
      for (let m = h === startHour ? startMinute : 0; m < 60; m++) {
        if (!spec.minutes.has(m)) continue;
        const result = new Date(day);
        result.setHours(h, m, 0, 0);
        if (result.getTime() < start.getTime()) {
          // DST fall-back: an ambiguous wall clock resolves to the earlier
          // offset, which can precede the scan start when `from` is in the
          // repeated hour. Retry at the later offset (usually +1h, sometimes
          // +30min) instead of returning a time in the past.
          const delta = (start.getTimezoneOffset() - result.getTimezoneOffset()) * 60_000;
          if (delta > 0) {
            const later = new Date(result.getTime() + delta);
            if (later.getHours() === h && later.getMinutes() === m && later.getTime() >= start.getTime()) return later;
          }
          continue;
        }
        return result;
      }
    }
  }
  throw new Error(`cron expression "${expr}" never fires`);
}

/* ---------------- store ---------------- */

/** Serialize read-modify-write cycles inside this process; atomic writes cover
 *  torn files across processes, but not lost updates. */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function normalizeTask(raw: unknown): CronTask | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.cron !== "string" || typeof o.prompt !== "string") return null;
  if (typeof o.cwd !== "string" || typeof o.nextRunAt !== "string") return null;
  const status = o.lastStatus === "ok" || o.lastStatus === "error" || o.lastStatus === "running" ? o.lastStatus : undefined;
  return {
    id: o.id,
    name: typeof o.name === "string" && o.name ? o.name : o.id,
    cron: o.cron,
    prompt: o.prompt,
    cwd: o.cwd,
    enabled: o.enabled !== false,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date(0).toISOString(),
    nextRunAt: o.nextRunAt,
    lastRunAt: typeof o.lastRunAt === "string" ? o.lastRunAt : undefined,
    lastStatus: status,
    lastError: typeof o.lastError === "string" ? o.lastError : undefined,
    lastLog: typeof o.lastLog === "string" ? o.lastLog : undefined,
    runStartedAt: typeof o.runStartedAt === "string" ? o.runStartedAt : undefined,
    runCount: typeof o.runCount === "number" && o.runCount >= 0 ? o.runCount : 0,
  };
}

/** Load the ledger. Throws on unreadable/corrupt files so callers can surface
 *  the problem instead of silently overwriting the user's tasks. */
export async function loadCronTasks(home = os.homedir()): Promise<CronTask[]> {
  const file = cronFilePath(home);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${file} is not valid JSON — fix it before managing scheduled tasks`);
  }
  const list = (parsed as { tasks?: unknown })?.tasks;
  if (!Array.isArray(list)) throw new Error(`${file} has no tasks array`);
  return list.map(normalizeTask).filter((t): t is CronTask => t !== null);
}

async function saveCronTasks(tasks: CronTask[], home: string): Promise<void> {
  const file = cronFilePath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, `${JSON.stringify({ tasks }, null, 2)}\n`, 0o600);
}

function makeId(): string {
  return `cr_${crypto.randomBytes(4).toString("hex")}`;
}

function presentTask(t: CronTask): CronTask {
  return { ...t };
}

function cleanName(name: string | undefined, prompt: string): string {
  const trimmed = (name ?? "").trim();
  const fallback = prompt.trim().replace(/\s+/g, " ").slice(0, 40) || "定时任务";
  return (trimmed || fallback).slice(0, NAME_MAX);
}

async function assertCwd(cwd: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(cwd);
  } catch {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
}

async function assertInput(input: CronTaskInput): Promise<void> {
  if (!input.prompt.trim()) throw new Error("prompt is required");
  if (input.prompt.length > PROMPT_MAX) throw new Error(`prompt is longer than ${PROMPT_MAX} characters`);
  if (!path.isAbsolute(input.cwd)) throw new Error("cwd must be an absolute path");
  await assertCwd(input.cwd);
  parseCron(input.cron);
}

export async function createCronTask(input: CronTaskInput, home = os.homedir()): Promise<CronTask> {
  return serialize(async () => {
    await assertInput(input);
    const tasks = await loadCronTasks(home);
    if (tasks.length >= MAX_CRON_TASKS) throw new Error(`at most ${MAX_CRON_TASKS} scheduled tasks`);
    const now = new Date();
    const task: CronTask = {
      id: makeId(),
      name: cleanName(input.name, input.prompt),
      cron: input.cron.trim(),
      prompt: input.prompt.trim(),
      cwd: input.cwd,
      enabled: input.enabled !== false,
      createdAt: now.toISOString(),
      nextRunAt: nextCronTime(input.cron, now).toISOString(),
      runCount: 0,
    };
    tasks.push(task);
    await saveCronTasks(tasks, home);
    return presentTask(task);
  });
}

export async function updateCronTask(id: string, patch: CronTaskPatch, home = os.homedir()): Promise<CronTask> {
  return serialize(async () => {
    const tasks = await loadCronTasks(home);
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new Error("scheduled task not found");

    const cron = patch.cron !== undefined ? patch.cron.trim() : task.cron;
    const prompt = patch.prompt !== undefined ? patch.prompt.trim() : task.prompt;
    const cwd = patch.cwd !== undefined ? patch.cwd : task.cwd;
    if (patch.cron !== undefined) parseCron(cron);
    if (!prompt) throw new Error("prompt is required");
    if (prompt.length > PROMPT_MAX) throw new Error(`prompt is longer than ${PROMPT_MAX} characters`);
    if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
    // Only validate a new working directory: a legacy task pointing at a
    // temporarily unavailable path must still be togglable.
    if (patch.cwd !== undefined && cwd !== task.cwd) await assertCwd(cwd);

    const scheduleChanged = patch.cron !== undefined && cron !== task.cron;
    const wasDisabled = !task.enabled;
    task.cron = cron;
    task.prompt = prompt;
    task.cwd = cwd;
    if (patch.name !== undefined) task.name = cleanName(patch.name, prompt);
    if (patch.enabled !== undefined) task.enabled = patch.enabled;
    if (scheduleChanged || (wasDisabled && task.enabled)) {
      task.nextRunAt = nextCronTime(cron, new Date()).toISOString();
    }
    await saveCronTasks(tasks, home);
    return presentTask(task);
  });
}

export async function deleteCronTask(id: string, home = os.homedir()): Promise<boolean> {
  return serialize(async () => {
    const tasks = await loadCronTasks(home);
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) return false;
    await saveCronTasks(next, home);
    return true;
  });
}

/** Claim every task whose nextRunAt has passed. Advances the schedule before
 *  the run starts so a crash cannot re-fire the same slot on restart. */
export async function claimDueTasks(now = new Date(), home = os.homedir()): Promise<CronTask[]> {
  return serialize(async () => {
    const tasks = await loadCronTasks(home);
    const claimed: CronTask[] = [];
    let changed = false;
    for (const task of tasks) {
      if (!task.enabled) continue;
      if (task.lastStatus === "running") {
        const started = task.runStartedAt ? new Date(task.runStartedAt).getTime() : Number.NaN;
        // A manual run started by a process that was then killed would
        // otherwise keep this task skipped forever: only a restart used to
        // reap interrupted runs. Apply the same stale threshold here.
        if (Number.isFinite(started) && now.getTime() - started < STALE_RUN_MS) continue;
        task.lastStatus = "error";
        task.lastError = INTERRUPTED_ERROR;
        task.runStartedAt = undefined;
        changed = true;
      }
      const due = new Date(task.nextRunAt).getTime();
      if (!Number.isFinite(due)) {
        // A corrupt timestamp would otherwise leave the task silently stuck.
        task.enabled = false;
        task.lastStatus = "error";
        task.lastError = `invalid nextRunAt "${task.nextRunAt}" — re-enable the task to reschedule`;
        claimed.push(presentTask(task));
        changed = true;
        continue;
      }
      if (due > now.getTime()) continue;
      let nextRunAt: string;
      try {
        nextRunAt = nextCronTime(task.cron, now).toISOString();
      } catch (err) {
        // A hand-edited expression that no longer parses must not wedge the
        // scheduler: disable the task and explain why.
        task.enabled = false;
        task.lastStatus = "error";
        task.lastError = err instanceof Error ? err.message : String(err);
        claimed.push(presentTask(task));
        changed = true;
        continue;
      }
      task.lastRunAt = now.toISOString();
      task.lastStatus = "running";
      task.lastError = undefined;
      task.runStartedAt = now.toISOString();
      task.runCount += 1;
      task.nextRunAt = nextRunAt;
      claimed.push(presentTask(task));
      changed = true;
    }
    if (changed) await saveCronTasks(tasks, home);
    return claimed;
  });
}

/** Mark a manual run as started without touching the schedule. */
export async function startCronRun(id: string, now = new Date(), home = os.homedir()): Promise<CronTask | null> {
  return serialize(async () => {
    const tasks = await loadCronTasks(home);
    const task = tasks.find((t) => t.id === id);
    if (!task) return null;
    // Another process (a different GUI/CLI) may be running this very task.
    // The stale threshold keeps a killed run from blocking it forever.
    const startedAt = task.runStartedAt ? new Date(task.runStartedAt).getTime() : Number.NaN;
    if (task.lastStatus === "running" && Number.isFinite(startedAt) && now.getTime() - startedAt < STALE_RUN_MS) {
      throw new Error("task is already running");
    }
    task.lastRunAt = now.toISOString();
    task.lastStatus = "running";
    task.lastError = undefined;
    task.runStartedAt = now.toISOString();
    task.runCount += 1;
    await saveCronTasks(tasks, home);
    return presentTask(task);
  });
}

export async function finishCronRun(
  id: string,
  result: { ok: boolean; error?: string; log?: string },
  home = os.homedir(),
): Promise<void> {
  await serialize(async () => {
    const tasks = await loadCronTasks(home);
    const task = tasks.find((t) => t.id === id);
    if (!task) return; // deleted while running — the run is already orphaned
    task.lastStatus = result.ok ? "ok" : "error";
    task.lastError = result.ok ? undefined : result.error ?? "run failed";
    task.lastLog = result.log ?? task.lastLog;
    task.runStartedAt = undefined;
    await saveCronTasks(tasks, home);
  });
}

/** Mark runs left in "running" by a killed process as errors. */
export async function recoverStaleRuns(home = os.homedir(), now = Date.now()): Promise<number> {
  return serialize(async () => {
    const tasks = await loadCronTasks(home);
    let recovered = 0;
    for (const task of tasks) {
      if (task.lastStatus !== "running") continue;
      const started = task.runStartedAt ? new Date(task.runStartedAt).getTime() : 0;
      if (Number.isFinite(started) && now - started < STALE_RUN_MS) continue;
      task.lastStatus = "error";
      task.lastError = INTERRUPTED_ERROR;
      task.runStartedAt = undefined;
      recovered++;
    }
    if (recovered) await saveCronTasks(tasks, home);
    return recovered;
  });
}

/** One-line description shared by /cron and the agent-facing list tool. */
export function formatCronTask(task: CronTask): string {
  const state = task.enabled ? (task.lastStatus === "error" ? "⚠" : "✓") : "⏸";
  const next = task.enabled ? new Date(task.nextRunAt).toLocaleString() : "disabled";
  const last = task.lastRunAt
    ? `last ${new Date(task.lastRunAt).toLocaleString()} ${task.lastStatus ?? ""}${task.lastError ? ` (${task.lastError})` : ""}`
    : "never run";
  return `${state} ${task.id}  ${task.cron}  next ${next}  ${last}  ${task.name}`;
}
