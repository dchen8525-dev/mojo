import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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

export async function expandFileReferences(text: string, cwd: string): Promise<{ text: string; files: string[] }> {
  const files: string[] = [];
  let budget = MAX_INLINE_BYTES;
  const replacements = new Map<string, string>();

  const matches = [...text.matchAll(AT_RE)];
  for (const m of matches) {
    const ref = m[2] ?? m[3];
    if (!ref || replacements.has(m[0])) continue;
    const abs = path.resolve(cwd, ref.replace(/\\/g, "/"));
    // Keep it inside the workspace, like the file tools do.
    if (!abs.startsWith(path.resolve(cwd) + path.sep) && abs !== path.resolve(cwd)) {
      replacements.set(m[0], m[0]);
      continue;
    }
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory() || budget <= 0) {
        replacements.set(m[0], m[0]);
        continue;
      }
      const content = await fs.readFile(abs, "utf8");
      budget -= content.length;
      const clipped = budget <= 0 ? content.slice(0, Math.max(0, content.length + budget)) + "\n[... truncated]" : content;
      replacements.set(m[0], `\n<file path="${ref}">\n${clipped}\n</file>\n`);
      files.push(ref);
    } catch {
      replacements.set(m[0], m[0]); // unknown path: leave the literal text
    }
  }

  let out = text;
  for (const [needle, repl] of replacements) out = out.split(needle).join(repl);
  return { text: out, files };
}
