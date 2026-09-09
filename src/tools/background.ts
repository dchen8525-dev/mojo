import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { openSync, readFileSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickWin32Shell } from "./bash.js";

/**
 * Background shell tasks: `bash run_in_background` starts a command that keeps
 * running across turns (dev servers, watch builds, long test suites) and
 * returns immediately. Output streams straight to a log file so the parent
 * never buffers it and `bash_output` can poll cheaply by byte offset.
 */

export interface BackgroundTask {
  id: string;
  command: string;
  logFile: string;
  startedAt: number;
  child: ChildProcessWithoutNullStreams;
  done: boolean;
  exitCode: number | null;
  killed: boolean;
  closePromise: Promise<void>;
}

/** Kill a process and, on Windows, its whole child tree (cmd → node → ...). */
export function killTree(child: { pid?: number }, isWin: boolean): void {
  if (isWin && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else if (child.pid) {
    // POSIX: the child was started detached (own process group), so a negative
    // pid signals the whole group. Fall back to the bare pid if that fails.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

class BackgroundManager {
  private tasks = new Map<string, BackgroundTask>();
  private next = 1;

  async start(command: string, cwd: string): Promise<BackgroundTask> {
    const id = `bg${this.next++}`;
    const dir = path.join(os.tmpdir(), "node-agent-output");
    await fs.mkdir(dir, { recursive: true });
    const logFile = path.join(dir, `${id}-${Date.now()}.log`);
    const fd = openSync(logFile, "w");
    const isWin = process.platform === "win32";
    const shell = isWin ? pickWin32Shell() : { exe: "/bin/bash", prefix: ["-lc"] };
    const child = spawn(shell.exe, [...shell.prefix, command], {
      cwd,
      env: process.env,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      windowsVerbatimArguments: isWin,
      detached: !isWin, // own process group so killTree can take down children
    }) as ChildProcessWithoutNullStreams;
    closeSync(fd); // the child holds its own dup
    child.unref(); // never keep the CLI alive just because a task runs

    const task: BackgroundTask = {
      id,
      command,
      logFile,
      startedAt: Date.now(),
      child,
      done: false,
      exitCode: null,
      killed: false,
      closePromise: new Promise<void>((resolve) => {
        child.on("close", (code) => {
          task.done = true;
          task.exitCode = code;
          resolve();
        });
        child.on("error", () => {
          task.done = true;
          task.exitCode = -1;
          resolve();
        });
      }),
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  kill(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || t.done) return false;
    t.killed = true;
    killTree(t.child, process.platform === "win32");
    return true;
  }

  /** Read log content starting at a byte offset; returns the new next offset. */
  readLog(t: BackgroundTask, since: number): { text: string; nextOffset: number } {
    try {
      const buf = readFileSync(t.logFile);
      const text = buf.subarray(Math.min(since, buf.length)).toString("utf8");
      return { text, nextOffset: buf.length };
    } catch {
      return { text: "", nextOffset: since };
    }
  }

  /** Kill everything still running (used by tests / shutdown). */
  killAll(): void {
    for (const t of this.tasks.values()) if (!t.done) this.kill(t.id);
  }
}

export const backgroundManager = new BackgroundManager();
