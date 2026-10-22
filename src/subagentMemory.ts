import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";
import type { Tool } from "./types.js";

/**
 * Persistent memory for named subagents (task tool with a stable `name`).
 *
 * Each named identity owns a private markdown file per scope - user-level
 * `~/.node-agent/subagent-memory/<name>.md` and project-level
 * `<cwd>/.node-agent/subagent-memory/<name>.md`. The files are injected into
 * the subagent's system prompt at spawn time and appended to through a gated
 * `save_memory` tool, so a specialist subagent accumulates durable findings
 * (conventions, file maps, gotchas) across sessions without touching the repo.
 *
 * Bounds and symlink guards mirror src/memory.ts.
 */

const MAX_INJECT_CHARS = 12_000; // per file, injected into the system prompt
const MAX_NOTE_CHARS = 8_000;
const MAX_NAME_CHARS = 40;
const MAX_MEMORY_FILE_BYTES = 512 * 1024;
/** After appends the file is trimmed back to this tail, at a section boundary. */
const TRIM_KEEP_BYTES = 256 * 1024;

export type SubagentMemoryScope = "project" | "user";

/** Lowercase slug of [a-z0-9_-]; null when nothing usable remains. */
export function sanitizeSubagentName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/, "");
  return name || null;
}

export function projectSubagentMemoryPath(cwd: string, name: string): string {
  return path.join(cwd, ".node-agent", "subagent-memory", `${name}.md`);
}

export function userSubagentMemoryPath(name: string, home: string = os.homedir()): string {
  return path.join(home, ".node-agent", "subagent-memory", `${name}.md`);
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(p);
    // Only regular files are memory; a planted symlink must not be followed.
    if (!stat.isFile()) return null;
    let raw: string;
    if (stat.size > MAX_MEMORY_FILE_BYTES) {
      const fh = await fs.open(p, "r");
      try {
        const buf = Buffer.alloc(MAX_MEMORY_FILE_BYTES);
        const { bytesRead } = await fh.read(buf, 0, buf.length, stat.size - buf.length);
        raw = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
      const nl = raw.indexOf("\n");
      if (nl >= 0) raw = raw.slice(nl + 1);
    } else {
      raw = await fs.readFile(p, "utf8");
    }
    const text = raw.replace(/^\uFEFF/, "").trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

/**
 * Memory is injected inside XML-ish wrappers; a note containing a closing tag
 * would end the block early and read as top-level instructions.
 */
function neutralizeWrapperTags(text: string): string {
  return text.replace(/<(\/?)(user_memory|project_memory|subagent_memory|memory_note)\b/gi, "&lt;$1$2");
}

/**
 * Render the memory blocks for the subagent's system prompt, or "" when the
 * identity has no memory yet. Read failures are silent.
 */
export async function renderSubagentMemory(cwd: string, name: string, home?: string): Promise<string> {
  try {
    const [user, project] = await Promise.all([
      readIfExists(userSubagentMemoryPath(name, home)),
      readIfExists(projectSubagentMemoryPath(cwd, name)),
    ]);
    const parts: string[] = [];
    if (user) {
      parts.push(
        `<user_memory file="~/.node-agent/subagent-memory/${name}.md">\n${neutralizeWrapperTags(user.slice(-MAX_INJECT_CHARS))}\n</user_memory>`,
      );
    }
    if (project) {
      parts.push(
        `<project_memory file=".node-agent/subagent-memory/${name}.md">\n${neutralizeWrapperTags(project.slice(-MAX_INJECT_CHARS))}\n</project_memory>`,
      );
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

/**
 * Append a titled note to the identity's memory file. Best-effort: memory
 * must never break a subagent run. Returns the path written, or null.
 */
export async function appendSubagentMemory(
  cwd: string,
  name: string,
  note: string,
  title: string,
  when: string,
  scope: SubagentMemoryScope = "project",
  home?: string,
): Promise<string | null> {
  try {
    const p = scope === "user" ? userSubagentMemoryPath(name, home) : projectSubagentMemoryPath(cwd, name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    try {
      // Never write through a planted symlink (memory file -> src/x.ts).
      if (!(await fs.lstat(p)).isFile()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const cleanTitle = title.replace(/\s+/g, " ").trim().slice(0, 80) || "Note";
    const body = `\n## ${cleanTitle} (${when})\n${note.trim().slice(0, MAX_NOTE_CHARS)}\n`;
    await fs.appendFile(p, body, "utf8");
    await trimMemoryFile(p);
    return p;
  } catch {
    return null;
  }
}

/** Keep the file bounded; memory is append-only, but not unbounded. */
async function trimMemoryFile(p: string): Promise<void> {
  const stat = await fs.stat(p);
  if (stat.size <= MAX_MEMORY_FILE_BYTES) return;
  const start = Math.max(0, stat.size - TRIM_KEEP_BYTES);
  const fh = await fs.open(p, "r");
  let tail: string;
  try {
    const buf = Buffer.alloc(stat.size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    tail = buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
  const boundary = tail.indexOf("\n## ");
  await atomicWriteFile(p, (boundary >= 0 ? tail.slice(boundary + 1) : tail).trimStart() + "\n");
}

/**
 * The gated write tool mounted into a named subagent's toolset. It always
 * routes through askPermission (runSubagent special-cases the tool name), so
 * even read-only research subagents save memory only with user approval.
 */
export function makeSaveMemoryTool(cwd: string, name: string, home?: string): Tool {
  return {
    name: "save_memory",
    description:
      `Save one durable, reusable finding to your persistent memory as "${name}" - it is loaded into ` +
      "your system prompt on every future run. One focused note per call: project conventions, file maps, " +
      "verified commands, gotchas. Never save secrets or task-ephemeral detail.",
    isReadOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short heading for the note (e.g. \"build system layout\")." },
        note: { type: "string", description: "The finding itself, dense markdown. Max ~8000 chars." },
        scope: {
          type: "string",
          enum: ["project", "user"],
          description: '"project" (default) = tied to this repo; "user" = machine-global for this identity.',
        },
      },
      required: ["note"],
    },
    async execute(input: Record<string, unknown>, ctx): Promise<{ content: string; isError?: boolean }> {
      const note = typeof input.note === "string" ? input.note.trim() : "";
      if (!note) return { content: "Error: note must not be empty", isError: true };
      const scope = input.scope === "user" ? "user" : "project";
      const title = typeof input.title === "string" ? input.title : "Note";
      const preview = `## ${title}\n${note.slice(0, 2000)}`;
      const ok = await ctx.askPermission(
        `Save a note to ${scope} subagent memory ("${name}")`,
        "low",
        preview,
      );
      if (!ok) return { content: "Memory save declined; nothing was written.", isError: true };
      const p = await appendSubagentMemory(cwd, name, note, title, new Date().toISOString().slice(0, 10), scope, home);
      if (!p) return { content: "Error: memory write failed", isError: true };
      return { content: `Saved to ${p}. It will be loaded on your next run.` };
    },
  };
}
