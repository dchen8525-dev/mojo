import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Session/journal retention: delete `*.jsonl` files under
 * `~/.node-agent/sessions` and `~/.node-agent/journal` whose last-modified
 * time is older than the retention window (default 14 days). AGENT_RETENTION_DAYS=0
 * disables cleanup entirely. Scheduled 60s after startup so it never delays
 * boot; the active session file is always protected via `keepIds`.
 */

export const DEFAULT_RETENTION_DAYS = 14;
export const RETENTION_CLEANUP_DELAY_MS = 60_000;

export interface RetentionCleanupOptions {
  home?: string;
  /**
   * Session ids (and journal-sanitized variants) whose files are never deleted.
   * A function is evaluated at cleanup time so a long-lived host (GUI) can
   * report the session it currently has open.
   */
  keepIds?: string[] | (() => string[]);
  now?: Date;
  retentionDays?: number;
  envRetentionDays?: string;
}

export interface RetentionCleanupResult {
  deletedFiles: string[];
  failedFiles: string[];
  retentionDays: number;
  scannedFiles: number;
}

export interface RetentionScheduleOptions extends Omit<RetentionCleanupOptions, "now"> {
  delayMs?: number;
  now?: () => Date;
  setTimeout?: (callback: () => void, delayMs: number) => { unref?(): void };
}

export function retentionDays(envRetentionDays: string | undefined = process.env.AGENT_RETENTION_DAYS): number {
  if (envRetentionDays === undefined || envRetentionDays.trim() === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number(envRetentionDays);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  if (parsed === 0) return 0;
  return parsed >= 1 ? Math.trunc(parsed) : DEFAULT_RETENTION_DAYS;
}

function retentionDirs(home: string): string[] {
  return [
    path.join(home, ".node-agent", "sessions"),
    path.join(home, ".node-agent", "journal"),
  ];
}

export async function cleanupRetention(
  options: RetentionCleanupOptions = {},
): Promise<RetentionCleanupResult> {
  const days = options.retentionDays ?? retentionDays(options.envRetentionDays);
  const result: RetentionCleanupResult = {
    deletedFiles: [],
    failedFiles: [],
    retentionDays: days,
    scannedFiles: 0,
  };
  if (days <= 0) return result;

  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const keepSource = typeof options.keepIds === "function" ? options.keepIds() : (options.keepIds ?? []);
  const keep = new Set(keepSource.flatMap((id) => [id.toLowerCase(), sanitizeRetentionId(id).toLowerCase()]));
  const home = options.home ?? os.homedir();

  for (const dir of retentionDirs(home)) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // missing or unreadable dir: nothing to clean there
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      if (keep.has(name.slice(0, -".jsonl".length).toLowerCase())) continue;
      result.scannedFiles += 1;
      const full = path.join(dir, name);
      try {
        const stat = await fs.lstat(full);
        if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
        // Re-check right before unlinking: another process may have resumed
        // this session between the two calls, and a fresh append must win.
        const latest = await fs.lstat(full);
        if (!latest.isFile() || latest.mtimeMs >= cutoffMs) continue;
        await fs.unlink(full);
        result.deletedFiles.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        result.failedFiles.push(name);
      }
    }
  }
  return result;
}

export function scheduleRetentionCleanup(options: RetentionScheduleOptions = {}): { unref?(): void } {
  const delayMs = options.delayMs ?? RETENTION_CLEANUP_DELAY_MS;
  const schedule = options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  return schedule(() => {
    void cleanupRetention({
      home: options.home,
      keepIds: options.keepIds,
      now: options.now?.(),
      retentionDays: options.retentionDays,
      envRetentionDays: options.envRetentionDays,
    }).catch(() => {});
  }, delayMs);
}

/** Same normalization as the journal's per-session file naming. */
function sanitizeRetentionId(id: string): string {
  return id.replace(/[^\w.-]/g, "_").slice(0, 120) || "unknown";
}
