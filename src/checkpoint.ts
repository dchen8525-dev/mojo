import { promises as fs, createReadStream } from "node:fs";
import crypto from "node:crypto";
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
  /** SHA-256 of the agent's post-edit content; absent for legacy checkpoints. */
  postHash?: string;
  /** Whether the file existed after the agent's write (false if it vanished). */
  postExisted?: boolean;
  /**
   * Absolute path the edit moved this file to (apply_patch). The target did
   * not exist before the edit, so undo/rewind remove it as well.
   */
  movedTo?: string;
  /** SHA-256 of the content written at `movedTo`; absent when it vanished. */
  movedToHash?: string;
}

export interface UndoResult {
  file: string;
  action: string;
  /** True when the file no longer matches what the agent wrote, so undo was refused. */
  conflict?: boolean;
  reason?: string;
}

export interface RewindFileConflict {
  file: string;
  reason: string;
}

export interface RewindOutcome {
  targetId: number;
  /** Files rolled back (or deleted) — empty when dryRun or conflicts refused. */
  applied: Array<{ file: string; action: string }>;
  /** Per-file reasons the rewind was refused; non-empty means nothing was applied. */
  conflicts: RewindFileConflict[];
  /** Checkpoint ids folded into this rewind (all active edits after the target). */
  entryIds: number[];
  /** True when this was a preview: nothing was applied or marked restored. */
  dryRun?: boolean;
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
  async capture(
    absPath: string,
    label: string,
    opts: { movedTo?: string } = {},
  ): Promise<CheckpointEntry | null> {
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
      if (opts.movedTo) entry.movedTo = opts.movedTo;
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
   * Record the file's state after the agent's write landed. Best-effort: a
   * failed stat/hash leaves the entry as a legacy checkpoint (undo allowed).
   */
  async finalize(entry: CheckpointEntry): Promise<void> {
    await this.load();
    const stored = this.entries.find((e) => e.id === entry.id);
    if (!stored) return;
    try {
      const stat = await fs.stat(stored.file);
      if (stat.isFile()) {
        stored.postHash = await hashFile(stored.file);
        stored.postExisted = true;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        stored.postExisted = false;
        delete stored.postHash;
      }
    }
    // The move target is the second half of the edit: record what landed there
    // so undo can verify nobody changed it before removing it.
    if (stored.movedTo) {
      try {
        stored.movedToHash = await hashFile(stored.movedTo);
      } catch {
        delete stored.movedToHash;
      }
    }
    await this.save();
  }

  /**
   * Restore the newest not-yet-undone checkpoint. Returns a human-readable
   * description, or null when there is nothing to undo. Refuses when the file
   * no longer matches the agent's post-edit content unless `force` is set, so
   * an undo can never silently clobber the user's own later edit.
   */
  async undoLast(opts: { force?: boolean } = {}): Promise<UndoResult | null> {
    await this.load();
    const entry = [...this.entries].reverse().find((e) => !e.restored);
    if (!entry) return null;

    if (!opts.force && (entry.postHash !== undefined || entry.postExisted === false)) {
      const current = await hashFileIfExists(entry.file);
      if (entry.postExisted === false) {
        if (current !== null) {
          return {
            file: entry.file,
            action: "refused",
            conflict: true,
            reason: "the file was re-created or changed after the agent removed it",
          };
        }
      } else if (current !== entry.postHash) {
        return {
          file: entry.file,
          action: "refused",
          conflict: true,
          reason: current === null
            ? "the file was deleted or moved after the agent's edit"
            : "the file was modified after the agent's edit",
        };
      }
      // A move wrote a second file; removing a copy the user has since edited
      // would discard their work, so treat that like any other later edit.
      if (entry.movedTo && entry.movedToHash) {
        const currentTarget = await hashFileIfExists(entry.movedTo);
        if (currentTarget !== null && currentTarget !== entry.movedToHash) {
          return {
            file: entry.file,
            action: "refused",
            conflict: true,
            reason: "the moved-to file was modified after the agent's move",
          };
        }
      }
    }

    if (entry.existed) {
      if (!entry.snapshot) throw new Error(`snapshot file is missing for checkpoint ${entry.id}`);
      await fs.mkdir(path.dirname(entry.file), { recursive: true });
      await fs.copyFile(entry.snapshot, entry.file);
      entry.restored = true;
      await this.save();
      if (entry.movedTo && entry.movedToHash) {
        await fs.rm(entry.movedTo, { force: true });
        return { file: entry.file, action: "restored previous content (removed the moved-to copy)" };
      }
      return { file: entry.file, action: "restored previous content" };
    }
    // The checkpoint captured a file that did not exist: undo = delete it.
    await fs.rm(entry.file, { force: true });
    entry.restored = true;
    await this.save();
    return { file: entry.file, action: "deleted (file was created by the agent)" };
  }

  /**
   * Roll the workspace back to the state just before checkpoint `targetId`:
   * every still-active checkpoint after it is folded into one rewind, each
   * file restored from its EARLIEST pre-image in the plan (deleting files the
   * agent created). Conflicts are checked per file against the LATEST
   * post-edit hash in the plan — any later user edit refuses the whole rewind
   * unless `force`. `dryRun` reports the plan and conflicts without touching
   * files or marking entries restored. Returns null for an unknown target id.
   */
  async rewindTo(targetId: number, opts: { force?: boolean; dryRun?: boolean } = {}): Promise<RewindOutcome | null> {
    await this.load();
    if (!this.entries.some((e) => e.id === targetId)) return null;
    // The target entry itself is included: it holds the pre-image of the
    // edit being reverted ("just before #N" undoes edit N and everything after).
    const plan = this.entries.filter((e) => e.id >= targetId && !e.restored);
    const outcome: RewindOutcome = { targetId, applied: [], conflicts: [], entryIds: plan.map((e) => e.id) };

    // One edit can touch two paths: the file itself and, for a move, its target
    // (which did not exist before, so rewinding past the move deletes it).
    type Effect = {
      id: number;
      file: string;
      existed: boolean;
      snapshot: string;
      postHash?: string;
      postExisted?: boolean;
    };
    const effects: Effect[] = [];
    for (const e of plan) {
      effects.push({
        id: e.id,
        file: e.file,
        existed: e.existed,
        snapshot: e.snapshot,
        postHash: e.postHash,
        postExisted: e.postExisted,
      });
      if (e.movedTo) {
        effects.push({
          id: e.id,
          file: e.movedTo,
          existed: false,
          snapshot: "",
          postHash: e.movedToHash,
          postExisted: e.movedToHash === undefined ? undefined : true,
        });
      }
    }

    // Conflict check: current content must match what the agent last left behind.
    const latest = new Map<string, Effect>();
    for (const e of effects) if (!latest.has(e.file) || latest.get(e.file)!.id < e.id) latest.set(e.file, e);
    if (!opts.force) {
      for (const e of latest.values()) {
        if (e.postHash === undefined && e.postExisted === undefined) continue; // legacy checkpoint, unverifiable
        const current = await hashFileIfExists(e.file);
        if (e.postExisted === false) {
          if (current !== null) outcome.conflicts.push({ file: e.file, reason: "re-created or changed after the agent removed it" });
        } else if (current !== e.postHash) {
          outcome.conflicts.push({
            file: e.file,
            reason: current === null ? "deleted or moved after the agent's edit" : "modified after the agent's edit",
          });
        }
      }
    }
    if (outcome.conflicts.length || opts.dryRun) {
      if (opts.dryRun) outcome.dryRun = true;
      return outcome;
    }

    // Restore: per file, the earliest entry's pre-image wins.
    const earliest = new Map<string, Effect>();
    for (const e of effects) if (!earliest.has(e.file)) earliest.set(e.file, e);
    for (const e of earliest.values()) {
      if (e.existed) {
        if (!e.snapshot) continue; // snapshot lost (pruned): nothing to restore from
        await fs.mkdir(path.dirname(e.file), { recursive: true });
        await fs.copyFile(e.snapshot, e.file);
        outcome.applied.push({ file: e.file, action: `restored content from before #${e.id}` });
      } else {
        await fs.rm(e.file, { force: true });
        outcome.applied.push({ file: e.file, action: `deleted (created after #${e.id})` });
      }
    }
    for (const e of plan) e.restored = true;
    await this.save();
    return outcome;
  }
}

async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Hash the current file, or null when it is missing/unreadable. */
async function hashFileIfExists(file: string): Promise<string | null> {
  try {
    return await hashFile(file);
  } catch {
    return null;
  }
}
