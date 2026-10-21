import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Skills: small instruction packages in `<dir>/<name>/SKILL.md` (project:
 * `.node-agent/skills`, user: `~/.node-agent/skills`). Only the name and a
 * one-line description are injected into the system prompt; the full body is
 * loaded on demand via the `skill` tool (progressive disclosure), so a large
 * skill library costs almost nothing per turn. Project skills shadow user
 * skills with the same name.
 */

export interface Skill {
  name: string;
  description: string;
  /** Absolute path of the SKILL.md file. */
  file: string;
  source: "user" | "project";
}

export function userSkillsDir(home: string = os.homedir()): string {
  return path.join(home, ".node-agent", "skills");
}

export function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".node-agent", "skills");
}

/**
 * Split a SKILL.md into frontmatter fields and body. Only `name` and
 * `description` are understood - a minimal line parser instead of a YAML
 * dependency. Without frontmatter the directory name is the skill name and
 * the whole file is the body.
 */
export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): { name: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { name: fallbackName, description: "", body: raw };
  const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
  const name = unquote(/^name:[ \t]*(.+)$/m.exec(m[1])?.[1]?.trim() ?? "") || fallbackName;
  const description = unquote(/^description:[ \t]*(.+)$/m.exec(m[1])?.[1]?.trim() ?? "");
  return { name, description, body: m[2] };
}

/** Discover skills from both directories. Project skills win on name clash. */
export async function listSkills(cwd: string, home?: string): Promise<Skill[]> {
  const dirs: Array<[string, Skill["source"]]> = [
    [userSkillsDir(home), "user"],
    [projectSkillsDir(cwd), "project"],
  ];
  const byName = new Map<string, Skill>();
  for (const [dir, source] of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // directory absent: no skills from this scope
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, "SKILL.md");
      const raw = await fs.readFile(file, "utf8").catch(() => null);
      if (raw === null) continue;
      const { name, description } = parseSkillMarkdown(raw.replace(/^\uFEFF/, ""), entry.name);
      byName.set(name, { name, description, file, source });
    }
  }
  return [...byName.values()];
}

/** The system-prompt block listing available skills. Empty when there are none. */
export function renderSkillsBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description || "(no description)"}`);
  return (
    "\n<available_skills>\n" +
    "Reusable instruction packages are available. When a task matches one of these, " +
    "call the skill tool with its name to load the full instructions before proceeding:\n" +
    lines.join("\n") +
    "\n</available_skills>\n"
  );
}
