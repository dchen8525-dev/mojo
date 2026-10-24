import { promises as fs } from "node:fs";
import type { MessageParam } from "./types.js";
import type { FileStateStore } from "./fileState.js";
import { systemReminder } from "./reminder.js";
import { relPath } from "./tools/utils.js";

/**
 * Post-compaction read-state restore. Compaction rewrites history and often
 * drops the contents of files the model has read, but the edit-freshness guard
 * still lets it edit them (the FileStateStore survives) — so it would edit
 * from memory. This module rebuilds a bounded bridge: after compaction, a
 * system-reminder re-injects the most recently read files (current on-disk
 * content, unchanged ones only) and one-line references for the rest.
 */

const MAX_FILES = 5;
const MAX_FILE_CHARS = 16_000;
const MAX_TOTAL_CHARS = 48_000;

/**
 * Build the reminder body, or null when there is nothing worth injecting.
 * `tailText` is lowercased text of the messages kept after compaction: files
 * still visible there are skipped.
 */
export async function buildReadStateReminderBody(
  reads: Array<{ path: string; full: boolean; mtimeMs: number; size: number }>,
  tailText: string,
  cwd: string,
): Promise<string | null> {
  const parts: string[] = [];
  let total = 0;
  for (const rec of reads.slice().reverse()) {
    // The tail text is JSON.stringify'd (backslashes escaped on Windows), so
    // match both the raw path and its JSON-escaped form (no surrounding quotes).
    const raw = rec.path.toLowerCase();
    const escaped = JSON.stringify(rec.path).slice(1, -1).toLowerCase();
    // read_file labels its output with the workspace-relative path, so a read
    // that is still visible in the kept tail never contains the absolute path.
    // Require the tool-result JSON prefix so a passing mention of the path in
    // prose does not suppress a restore the model still needs.
    const relRaw = relPath(cwd, rec.path);
    const relHeader = relRaw.toLowerCase();
    const relHeaderEscaped = JSON.stringify(relRaw).slice(1, -1).toLowerCase();
    if (
      tailText.includes(raw) ||
      tailText.includes(escaped) ||
      tailText.includes(`"content":"${relHeader}\\n`) ||
      tailText.includes(`"content":"${relHeaderEscaped}\\n`)
    ) {
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(rec.path);
    } catch {
      continue;
    }
    const unchanged = stat.mtimeMs === rec.mtimeMs && stat.size === rec.size;
    const rel = relPath(cwd, rec.path);
    if (!unchanged) {
      parts.push(`- ${rel}: read earlier, but it has changed on disk since — re-read before editing.`);
      continue;
    }
    if (rec.full && stat.size <= MAX_FILE_CHARS && total + stat.size <= MAX_TOTAL_CHARS) {
      try {
        const text = await fs.readFile(rec.path, "utf8");
        parts.push(`- ${rel} (unchanged since your full read; content restored):\n\`\`\`\n${text.trimEnd()}\n\`\`\``);
        total += stat.size;
        continue;
      } catch {
        // fall through to the reference line
      }
    }
    parts.push(
      `- ${rel}: you read it earlier (${rec.full ? "full" : "partial"} read, unchanged since), ` +
        "but its contents are no longer in context — re-read if you need them.",
    );
  }
  if (!parts.length) return null;
  return (
    "Compaction dropped earlier file contents from history. Current state of your recent reads:\n\n" +
    parts.join("\n\n")
  );
}

/**
 * Build the full reminder message, or null. Files already visible in the kept
 * tail are excluded; the body degrades to one-line references for oversized
 * or partial reads.
 */
export async function buildReadStateReminder(
  fileState: FileStateStore,
  tail: MessageParam[],
  cwd: string,
): Promise<string | null> {
  const reads = fileState.recent(MAX_FILES);
  if (!reads.length) return null;
  const tailText = JSON.stringify(tail).toLowerCase();
  const body = await buildReadStateReminderBody(reads, tailText, cwd);
  if (!body) return null;
  return systemReminder(body, { event: "ReadStateRestored" });
}
