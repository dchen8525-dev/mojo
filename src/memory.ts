import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-session memory: a plain markdown file (project-level
 * `.node-agent/memory.md`, plus a user-level `~/.node-agent/memory.md`) that
 * is injected into the system prompt of every session and appended to
 * automatically when a context compaction produces a handoff summary. Facts,
 * decisions and gotchas therefore survive across restarts without the model
 * having to do anything.
 */

const MAX_INJECT_CHARS = 24_000; // keep prompt injection bounded

export function projectMemoryPath(cwd: string): string {
  return path.join(cwd, ".node-agent", "memory.md");
}

export function userMemoryPath(home: string = os.homedir()): string {
  return path.join(home, ".node-agent", "memory.md");
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const text = raw.replace(/^\uFEFF/, "").trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

/**
 * Render the memory block for the system prompt. Both files are optional;
 * returns "" when neither exists. Each source is truncated from the front
 * (newest entries are appended at the bottom, so keep the tail).
 */
export async function renderMemory(cwd: string, home?: string): Promise<string> {
  const [user, project] = await Promise.all([readIfExists(userMemoryPath(home)), readIfExists(projectMemoryPath(cwd))]);
  if (!user && !project) return "";
  const per = Math.floor(MAX_INJECT_CHARS / 2);
  const clip = (s: string) => (s.length > per ? "…" + s.slice(s.length - per) : s);
  const sections: string[] = [];
  if (user) sections.push(`<user_memory file="~/.node-agent/memory.md">\n${clip(user)}\n</user_memory>`);
  if (project) sections.push(`<project_memory file=".node-agent/memory.md">\n${clip(project)}\n</project_memory>`);
  return (
    "\nLong-term memory from earlier sessions (facts, decisions, gotchas). Trust it over guesswork, follow recorded user preferences, and update it via edit_file when the user asks you to remember something:\n" +
    sections.join("\n") +
    "\n"
  );
}

/**
 * Append a compaction handoff summary to the project memory file so its
 * decisions and gotchas outlive the session. Best-effort: memory must never
 * break compaction. Returns the path written, or null on failure.
 */
export async function appendMemoryNote(cwd: string, note: string, when: string): Promise<string | null> {
  try {
    const p = projectMemoryPath(cwd);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const body = `\n## Session note (${when})\n${note.trim()}\n`;
    await fs.appendFile(p, body, "utf8");
    return p;
  } catch {
    return null;
  }
}
