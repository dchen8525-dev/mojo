import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { truncate } from "./tools/utils.js";

/**
 * Bound a tool result WITHOUT losing information permanently: when the text
 * exceeds `max`, the full text is spilled to a temp file and the returned
 * value keeps head + tail plus a pointer the model can follow with read_file.
 * Unlike truncate() alone, the omitted middle stays recoverable.
 */
export async function boundedResult(text: string, max = 30_000, label = "result"): Promise<string> {
  if (text.length <= max) return text;
  const file = await spill(text, label);
  const kept = truncate(text, max);
  if (!file) return kept;
  return (
    kept +
    `\n[Full ${label} (${text.length.toLocaleString()} chars) saved to ${file} - ` +
    `read it with read_file (offset/limit to page through).]`
  );
}

async function spill(text: string, label: string): Promise<string | null> {
  try {
    const dir = path.join(os.tmpdir(), "node-agent-output");
    await fs.mkdir(dir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "result";
    const file = path.join(dir, `${safeLabel}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    await fs.writeFile(file, text, "utf8");
    return file;
  } catch {
    return null; // best-effort; truncation still bounds the output
  }
}
