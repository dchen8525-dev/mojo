import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * File checkpoints: before write_file/edit_file touches a file, the current
 * content is copied under ~/.node-agent/checkpoints/<session>/. `/undo`
 * restores the most recent checkpoint (LIFO), so a botched agent edit can be
 * rolled back even in a repo with no git safety net.
 *
 * Snapshots are raw byte copies (binary-safe). Files that did not exist yet
 * are recorded with existed=false; undoing one deletes the created file.
 */

export interface CheckpointEntry {
  id: number;
  file: string; // absolute path of the original file
  snapshot: string; // absolute path of the stored copy ("" when the file did not exist)
  existed: boolean;
  label: string; // which tool captured it: "write_file" | "edit_file"
  ts: string; // ISO timestamp
  restored: boolean;
}

export const MAX_CHECKPOINTS = 50;

export class CheckpointStore {
  private entries: CheckpointEntry[] = [];
  private nextId = 1;
  private loaded = false;
  private dir: string;

  constructor(sessionId: string, dir?: string) {
    this.dir = dir ?? path.join(os.homedir(), ".node-agent", "checkpoints", sessionId.replace(/[^\w.-]/g, "_"));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(path.join(this.dir, "index.json"), "utf8");
      const obj = JSON.parse(raw.replace(/^﻿/, "")) as { entries: CheckpointEntry[]; nextId: number };
      this.entries = obj.entries ?? [];
      this.nextId = obj.nextId ?? this.entries.length + 1;
    } catch {
      /* first checkpoint of the session */
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, "index.json"), JSON.stringify({ entries: this.entries, nextId: this.nextId }), "utf8");
  }

  /** Copy the file's current content aside before it is overwritten. Best-effort: never blocks the edit. */
  async capture(absPath: string, label: string): Promise<CheckpointEntry | null> {
    try {
      await this.load();
      const existed = await fs
        .access(absPath)
        .then(() => true)
        .catch(() => false);
      const entry: CheckpointEntry = {
        id: this.nextId++,
        file: absPath,
        snapshot: "",
        existed,
        label,
        ts: new Date().toISOString(),
        restored: false,
      };
      if (existed) {
        await fs.mkdir(this.dir, { recursive: true });
        entry.snapshot = path.join(this.dir, `snap-${entry.id}.bin`);
        await fs.copyFile(absPath, entry.snapshot);
      }
      this.entries.push(entry);
      await this.prune();
      await this.save();
      return entry;
    } catch {
      return null; // checkpointing must never break the actual write
    }
  }

  /** Drop the oldest entries (and their snapshot files) beyond MAX_CHECKPOINTS. */
  private async prune(): Promise<void> {
    while (this.entries.length > MAX_CHECKPOINTS) {
      const [oldest] = this.entries;
      this.entries.shift();
      if (oldest.snapshot) await fs.rm(oldest.snapshot, { force: true }).catch(() => {});
    }
  }

  async list(): Promise<CheckpointEntry[]> {
    await this.load();
    return [...this.entries];
  }

  /**
   * Restore the newest not-yet-undone checkpoint. Returns a human-readable
   * description, or null when there is nothing to undo.
   */
  async undoLast(): Promise<{ file: string; action: string } | null> {
    await this.load();
    const entry = [...this.entries].reverse().find((e) => !e.restored);
    if (!entry) return null;
    if (entry.existed) {
      if (!entry.snapshot) throw new Error(`snapshot file is missing for checkpoint ${entry.id}`);
      await fs.mkdir(path.dirname(entry.file), { recursive: true });
      await fs.copyFile(entry.snapshot, entry.file);
      entry.restored = true;
      await this.save();
      return { file: entry.file, action: "restored previous content" };
    }
    // The checkpoint captured a file that did not exist: undo = delete it.
    await fs.rm(entry.file, { force: true });
    entry.restored = true;
    await this.save();
    return { file: entry.file, action: "deleted (file was created by the agent)" };
  }
}
