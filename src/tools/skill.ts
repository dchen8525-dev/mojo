import { promises as fs } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { str, truncate } from "./utils.js";
import { listSkills, parseSkillMarkdown } from "../skills.js";

/**
 * Progressive disclosure: the system prompt only carries skill names and
 * descriptions; this tool loads one skill's full instructions on demand.
 */
export const skillTool: Tool = {
  name: "skill",
  description:
    "Load the full instructions of an available skill (listed in <available_skills> in the " +
    "system prompt). Call this once when a task matches a skill, then follow the returned " +
    "instructions. Results are bounded and read-only.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name from <available_skills>." },
    },
    required: ["name"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = str(input, "name");
    const skills = await listSkills(ctx.cwd);
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      return {
        content: `Error: no skill "${name}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`,
        isError: true,
      };
    }
    const raw = await fs.readFile(skill.file, "utf8").catch(() => null);
    if (raw === null) {
      return { content: `Error: could not read ${skill.file}`, isError: true };
    }
    const { body } = parseSkillMarkdown(raw.replace(/^\uFEFF/, ""), skill.name);
    return {
      content: truncate(`<skill name="${skill.name}" source="${skill.source}">\n${body.trim()}\n</skill>`, 40_000),
    };
  },
};
