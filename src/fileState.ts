import { promises as fs } from "node:fs";
import { relPath } from "./tools/utils.js";

/**
 * Per-session record of files the model has read (or successfully written),
 * used to block edits made from stale or imaginary context: overwriting a file
 * it never read, or one that changed on disk after the read. Records are
 * refreshed by every successful write, so consecutive edits stay allowed.
 */

interface ReadRecord {
  mtimeMs: number;
  size: number;
  /** The read covered the whole file (offset 0 through EOF). */
  full: boolean;
}

export class FileStateStore {
  private reads = new Map<string, ReadRecord>();

  private key(absPath: string): string {
    return process.platform === "win32" ? absPath.toLowerCase() : absPath;
  }

  record(absPath: string, stat: { mtimeMs: number; size: number }, full = true) {
    this.reads.set(this.key(absPath), { mtimeMs: stat.mtimeMs, size: stat.size, full });
  }

  /** Record the on-disk state after our own write (content is current in context). */
  async recordCurrent(absPath: string): Promise<void> {
    try {
      this.record(absPath, await fs.stat(absPath), true);
    } catch {
      this.reads.delete(this.key(absPath));
    }
  }

  has(absPath: string): boolean {
    return this.reads.has(this.key(absPath));
  }

  clear() {
    this.reads.clear();
  }

  /**
   * Why modifying `absPath` must wait, or null when it is safe. A missing file
   * is always safe (creating it destroys nothing). `requireFullRead` applies to
   * whole-file overwrites, which must not run from a partial view.
   */
  async check(absPath: string, requireFullRead = false): Promise<"unread" | "stale" | "partial" | null> {
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      return null;
    }
    if (stat.isDirectory()) return null; // let the caller produce its own error
    const rec = this.reads.get(this.key(absPath));
    if (!rec) return "unread";
    if (rec.mtimeMs !== stat.mtimeMs || rec.size !== stat.size) return "stale";
    if (requireFullRead && !rec.full) return "partial";
    return null;
  }
}

export function editGuardMessage(cwd: string, absPath: string, reason: "unread" | "stale" | "partial"): string {
  const rel = relPath(cwd, absPath);
  if (reason === "unread") {
    return (
      `Error: ${rel} has not been read in this session, so editing it could destroy content you have not seen. ` +
      `Read it first with read_file, then retry.`
    );
  }
  if (reason === "partial") {
    return (
      `Error: ${rel} was only partially read. Overwriting the whole file from a partial view would drop the rest; ` +
      `read the full file first (offset 0, no limit), or use edit_file for a targeted change.`
    );
  }
  return `Error: ${rel} changed on disk after you read it (another process or the user edited it). Read it again, then retry.`;
}
