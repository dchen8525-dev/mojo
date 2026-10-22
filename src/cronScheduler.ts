import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimDueTasks,
  cronDir,
  cronRunsDir,
  finishCronRun,
  loadCronTasks,
  recoverStaleRuns,
  startCronRun,
  type CronTask,
} from "./cron.js";

/**
 * Single-owner scheduler for cron.ts tasks. One process holds a pid lease in
 * ~/.node-agent/cron-scheduler.json; every other agent falls back to standby
 * and polls until the owner exits. Due tasks are executed by re-spawning the
 * agent CLI in print mode, so a scheduled turn gets the same tools,
 * permissions and model as a normal `agent -p` invocation.
 */

export interface CronRunResult {
  ok: boolean;
  error?: string;
  log?: string;
}

export type CronRunner = (task: CronTask) => Promise<CronRunResult>;

export interface CronSchedulerOptions {
  home?: string;
  /** Poll interval for due tasks and lease re-acquisition. */
  intervalMs?: number;
  /** Upper bound for one scheduled turn; the child is killed when exceeded. */
  runTimeoutMs?: number;
  runner?: CronRunner;
  log?: (message: string) => void;
  /** Called after a run settles (or a due task is disabled) so GUIs can refresh. */
  onChange?: () => void;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function cronLeasePath(home = os.homedir()): string {
  return path.join(cronDir(home), "cron-scheduler.json");
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : fallback;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLease(file: string): Promise<{ pid?: number; token?: string } | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as { pid?: unknown; token?: unknown };
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
    };
  } catch {
    return null; // absent or unreadable — claimable
  }
}

/** Re-run the same CLI the current process was started from. */
function cliCommand(): { command: string; args: string[] } {
  const override = process.env.AGENT_CLI_ENTRY?.trim();
  if (override) return { command: process.execPath, args: [override] };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const built = path.join(here, "cli.js");
  if (existsSync(built)) return { command: process.execPath, args: [built] };
  // Source checkout under tsx: argv[1] is src/cli.ts and execArgv carries the loader.
  const entry = process.argv[1];
  if (entry && existsSync(entry) && /\.(?:ts|js)$/.test(entry) && /cli\.(?:ts|js)$/.test(entry)) {
    const execArgv = process.execArgv.filter((a) => a !== "--eval" && a !== "-e");
    return { command: process.execPath, args: [...execArgv, entry] };
  }
  throw new Error("cannot locate the agent CLI entry for scheduled runs — start dist/cli.js or set AGENT_CLI_ENTRY");
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // detached child leads its own group
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** Spawn `agent -p <prompt> --auto --no-lsp` in the task's cwd and log output. */
export function createProcessRunner(opts: { home?: string; timeoutMs?: number } = {}): CronRunner {
  const home = opts.home ?? os.homedir();
  const timeoutMs = opts.timeoutMs ?? envMs("AGENT_CRON_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  return async (task) => {
    let command: string;
    let baseArgs: string[];
    try {
      ({ command, args: baseArgs } = cliCommand());
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const runsDir = cronRunsDir(home);
    await fs.mkdir(runsDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = path.join(runsDir, `${task.id}-${stamp}.log`);
    const out = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    // An unwritable log must not crash the scheduler or abort the run.
    out.on("error", () => {});
    out.write(`# ${new Date().toISOString()} ${task.name}\n# cron ${task.cron} · cwd ${task.cwd}\n# prompt: ${task.prompt}\n\n`);

    let child: ChildProcess;
    try {
      child = spawn(command, [...baseArgs, "-p", task.prompt, "--auto", "--no-lsp"], {
        cwd: task.cwd,
        env: {
          ...process.env,
          AGENT_CRON_RUN: task.id,
          AGENT_CRON_TASK: task.name,
          AGENT_NO_CRON: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      out.end();
      return { ok: false, error: err instanceof Error ? err.message : String(err), log: logFile };
    }

    let stderrTail = "";
    child.stdout?.on("data", (d: Buffer) => out.write(d));
    child.stderr?.on("data", (d: Buffer) => {
      out.write(d);
      stderrTail = (stderrTail + d.toString("utf8")).slice(-4000);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref?.();

    const outcome = await new Promise<{ code: number | null; error?: string }>((resolve) => {
      let settled = false;
      const done = (v: { code: number | null; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      child.once("error", (err) => done({ code: null, error: err.message }));
      child.once("close", (code) => done({ code }));
    });
    clearTimeout(timer);
    out.end(`\n# exit ${outcome.code ?? "error"}${timedOut ? " (timed out)" : ""}\n`);

    if (timedOut) {
      return {
        ok: false,
        error: `run timed out after ${Math.round(timeoutMs / 60_000)} min and was killed`,
        log: logFile,
      };
    }
    if (outcome.error) return { ok: false, error: outcome.error, log: logFile };
    if (outcome.code !== 0) {
      const tail = stderrTail.trim().split("\n").slice(-5).join(" · ");
      return { ok: false, error: `exit code ${outcome.code ?? "?"}${tail ? `: ${tail}` : ""}`, log: logFile };
    }
    return { ok: true, log: logFile };
  };
}

export class CronScheduler {
  private readonly home: string;
  private readonly intervalMs: number;
  private readonly runner: CronRunner;
  private readonly log: (message: string) => void;
  private readonly onChange?: () => void;
  private readonly token = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private owner = false;
  private ticking = false;
  private readonly running = new Set<string>();
  private runChain: Promise<unknown> = Promise.resolve();

  constructor(opts: CronSchedulerOptions = {}) {
    this.home = opts.home ?? os.homedir();
    this.intervalMs = opts.intervalMs ?? envMs("AGENT_CRON_TICK_MS", DEFAULT_INTERVAL_MS);
    this.runner = opts.runner ?? createProcessRunner({ home: this.home, timeoutMs: opts.runTimeoutMs });
    this.log = opts.log ?? ((m) => console.error(m));
    this.onChange = opts.onChange;
  }

  get isOwner(): boolean {
    return this.owner;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Acquire the lease and start polling. Returns whether this process owns it. */
  async start(): Promise<boolean> {
    if (process.env.AGENT_CRON_RUN || process.env.AGENT_NO_CRON) return false;
    if (this.started) return this.owner;
    this.started = true;
    try {
      const recovered = await recoverStaleRuns(this.home);
      if (recovered) this.log(`cron: marked ${recovered} interrupted run(s) as failed`);
    } catch (err) {
      this.log(`cron: cannot read task ledger: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this.owner;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.owner = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const file = cronLeasePath(this.home);
    const lease = await readLease(file);
    if (lease?.token === this.token) await fs.unlink(file).catch(() => {});
  }

  private async ensureLease(): Promise<boolean> {
    const file = cronLeasePath(this.home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // `wx` makes create-if-absent atomic: when several processes start at the
    // same instant exactly one wins and the rest read its token and stand by.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await fs.open(file, "wx", 0o600);
        try {
          const body = JSON.stringify({ pid: process.pid, token: this.token, startedAt: new Date().toISOString() });
          await handle.writeFile(`${body}\n`);
        } finally {
          await handle.close();
        }
        this.owner = true;
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          this.owner = false;
          this.log(`cron: cannot write scheduler lease: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      }
      const current = await readLease(file);
      if (current?.token === this.token) {
        this.owner = true;
        return true;
      }
      if (current?.pid !== undefined && isAlive(current.pid)) {
        this.owner = false;
        return false;
      }
      // Dead or unreadable lease: remove that exact snapshot, then retry the
      // exclusive create. Re-reading first avoids deleting a fresh lease that
      // another process claimed after our first read.
      const again = await readLease(file);
      if (again?.pid !== current?.pid || again?.token !== current?.token) continue;
      await fs.unlink(file).catch(() => {});
    }
    this.owner = false;
    return false;
  }

  /** One scheduler pass: acquire the lease, claim due tasks, run them serially. */
  async tick(): Promise<void> {
    if (!this.started || this.ticking) return;
    this.ticking = true;
    try {
      if (!(await this.ensureLease())) return;
      let due: CronTask[];
      try {
        due = await claimDueTasks(new Date(), this.home);
      } catch (err) {
        this.log(`cron: cannot claim tasks: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      for (const task of due) {
        // Claimed as error means the expression no longer parses; it was
        // disabled in the store and there is nothing to execute.
        if (!task.enabled || task.lastStatus === "error") {
          this.onChange?.();
          continue;
        }
        await this.enqueue(task);
      }
    } catch (err) {
      this.log(`cron: scheduler pass failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private enqueue(task: CronTask): Promise<CronRunResult> {
    const run = this.runChain.then(async () => {
      if (this.running.has(task.id)) return { ok: false, error: "task is already running" };
      this.running.add(task.id);
      this.log(`cron: running ${task.id} "${task.name}" (${task.cron})`);
      try {
        const result = await this.runner(task);
        await finishCronRun(task.id, result, this.home);
        this.log(`cron: ${task.id} ${result.ok ? "finished" : `failed: ${result.error ?? "unknown error"}`}`);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await finishCronRun(task.id, { ok: false, error }, this.home).catch(() => {});
        this.log(`cron: ${task.id} failed: ${error}`);
        return { ok: false, error };
      } finally {
        this.running.delete(task.id);
        this.onChange?.();
      }
    });
    this.runChain = run.catch(() => {});
    return run;
  }

  /** Run a task immediately without touching its schedule. */
  async runNow(id: string): Promise<CronRunResult> {
    const started = await this.beginManualRun(id);
    if ("error" in started) return { ok: false, error: started.error };
    return this.enqueue(started.task);
  }

  /** Queue a manual run and return as soon as it is accepted (UI-friendly). */
  async runNowDetached(id: string): Promise<CronRunResult> {
    const started = await this.beginManualRun(id);
    if ("error" in started) return { ok: false, error: started.error };
    void this.enqueue(started.task);
    return { ok: true };
  }

  private async beginManualRun(id: string): Promise<{ task: CronTask } | { error: string }> {
    if (this.running.has(id)) return { error: "task is already running" };
    let task: CronTask | null;
    try {
      const tasks = await loadCronTasks(this.home);
      task = tasks.find((t) => t.id === id) ?? null;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (!task) return { error: "scheduled task not found" };
    const started = await startCronRun(id, new Date(), this.home);
    if (!started) return { error: "scheduled task not found" };
    return { task: started };
  }
}

/** Shared across the CLI UI and the GUI backend. */
export function createCronScheduler(opts: CronSchedulerOptions = {}): CronScheduler {
  return new CronScheduler(opts);
}
