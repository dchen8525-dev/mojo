import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSensitivePath } from "./tools/utils.js";

/**
 * Custom slash commands: markdown files in ~/.node-agent/commands/ (global)
 * or .node-agent/commands/ (project). File name = command name; file body is
 * the prompt template, with $ARGUMENTS (or $1..$9) substituted from the
 * invocation. Project files override global ones with the same name.
 */

export interface SlashCommand {
  name: string;
  description: string;
  /** Template body. */
  template: string;
  source: "global" | "project";
}

export async function loadSlashCommands(cwd: string): Promise<Map<string, SlashCommand>> {
  const dirs: Array<{ dir: string; source: "global" | "project" }> = [
    { dir: path.join(os.homedir(), ".node-agent", "commands"), source: "global" },
    { dir: path.join(cwd, ".node-agent", "commands"), source: "project" },
  ];
  const out = new Map<string, SlashCommand>();
  for (const { dir, source } of dirs) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files.filter((f) => f.endsWith(".md"))) {
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const name = f.replace(/\.md$/, "");
        // Optional front-matter: description for /help listings.
        let description = "";
        let body = raw;
        const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
        if (fm) {
          const dm = fm[1].match(/^description:\s*(.+)$/m);
          if (dm) description = dm[1].trim();
          body = raw.slice(fm[0].length);
        }
        if (!description) {
          const firstLine = body.trim().split("\n")[0] ?? "";
          description = firstLine.slice(0, 80);
        }
        out.set(name, { name, description, template: body.trim(), source });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}

/** Fill $ARGUMENTS / $1..$9 in a command template. */
export function renderCommand(template: string, args: string[]): string {
  let out = template.replaceAll("$ARGUMENTS", args.join(" "));
  args.slice(0, 9).forEach((a, i) => {
    out = out.replaceAll(`$${i + 1}`, a);
  });
  if (!/\$ARGUMENTS|\$\d/.test(template) && args.length) {
    out += `\n\nUser request: ${args.join(" ")}`;
  }
  return out;
}

/**
 * Expand @file references in user input into inline file contents, like
 * Claude Code. @path may be quoted; directories and unknown paths are left
 * as literal text. Total inlined bytes are capped.
 */
const AT_RE = /@("([^"]+)"|([^\s,;()]+))/g;
const MAX_INLINE_BYTES = 200_000;

function isInside(root: string, target: string): boolean {
  const cmp = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const r = cmp(root);
  const t = cmp(target);
  return t === r || t.startsWith(r + path.sep);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/**
 * Inline the first `cap` bytes of a file. Reading a bounded prefix keeps a
 * stray `@big.dump` from buffering gigabytes just to throw the tail away;
 * `O_NONBLOCK` keeps a FIFO from stalling the submit path.
 */
async function readPrefix(abs: string, cap: number): Promise<Buffer | undefined> {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await fs.open(abs, flags);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const size = Math.min(stat.size, cap);
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Drop an incomplete UTF-8 sequence left by cutting at a byte boundary. */
function trimPartialUtf8(data: Buffer): Buffer {
  for (let back = 1; back <= 4 && back <= data.length; back++) {
    const byte = data[data.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: look further back
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? data.subarray(0, data.length - back) : data;
  }
  return data;
}

export async function expandFileReferences(text: string, cwd: string): Promise<{ text: string; files: string[] }> {
  const files: string[] = [];
  let budget = MAX_INLINE_BYTES;
  const replacements = new Map<string, string>();
  const root = path.resolve(cwd);
  const realRoot = await fs.realpath(root).catch(() => root);

  const matches = [...text.matchAll(AT_RE)];
  for (const m of matches) {
    const ref = m[2] ?? m[3];
    if (!ref || replacements.has(m[0])) continue;
    const abs = path.resolve(root, ref.replace(/\\/g, "/"));
    // Keep it inside the workspace, like the file tools do.
    if (!isInside(root, abs) || budget <= 0) {
      replacements.set(m[0], m[0]);
      continue;
    }
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        replacements.set(m[0], m[0]);
        continue;
      }
      // A workspace symlink can point at a credential store or outside the
      // repo; the lexical check above cannot see the target.
      const real = await fs.realpath(abs);
      if (isSensitivePath(real) || !isInside(realRoot, real)) {
        replacements.set(m[0], m[0]);
        continue;
      }
      const data = await readPrefix(abs, budget + 1);
      if (!data || data.subarray(0, 8192).includes(0)) {
        replacements.set(m[0], m[0]); // unreadable or binary
        continue;
      }
      const truncated = data.length > budget;
      const content = (truncated ? trimPartialUtf8(data.subarray(0, budget)) : data).toString("utf8");
      budget = truncated ? 0 : budget - data.length;
      replacements.set(
        m[0],
        `\n<file path="${escapeAttr(ref)}">\n${content}${truncated ? "\n[... truncated]" : ""}\n</file>\n`,
      );
      files.push(ref);
    } catch {
      replacements.set(m[0], m[0]); // unknown path: leave the literal text
    }
  }

  let out = text;
  for (const [needle, repl] of replacements) out = out.split(needle).join(repl);
  return { text: out, files };
}
