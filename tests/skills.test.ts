import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSkills,
  parseSkillMarkdown,
  projectSkillsDir,
  renderSkillsBlock,
  userSkillsDir,
} from "../src/skills.js";
import { skillTool } from "../src/tools/skill.js";
import type { ToolContext } from "../src/types.js";

let root: string;
let home: string;
let cwd: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-"));
  home = path.join(root, "home");
  cwd = path.join(root, "proj");
  await fs.mkdir(path.join(home, ".node-agent", "skills"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".node-agent", "skills"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeSkill(base: string, dir: string, content: string) {
  const d = path.join(base, dir);
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(d, "SKILL.md"), content, "utf8");
}

describe("parseSkillMarkdown", () => {
  it("extracts frontmatter name and description", () => {
    const r = parseSkillMarkdown('---\nname: deploy\ndescription: "Ship the app"\n---\n\nDo the deploy steps.', "dir");
    expect(r.name).toBe("deploy");
    expect(r.description).toBe("Ship the app");
    expect(r.body).toContain("Do the deploy steps.");
    expect(r.body).not.toContain("description:");
  });

  it("falls back to the directory name without frontmatter", () => {
    const r = parseSkillMarkdown("Just some instructions.", "fallback");
    expect(r.name).toBe("fallback");
    expect(r.description).toBe("");
    expect(r.body).toBe("Just some instructions.");
  });

  it("falls back to the directory name when name is absent", () => {
    const r = parseSkillMarkdown("---\ndescription: only a description\n---\nbody", "fallback");
    expect(r.name).toBe("fallback");
    expect(r.description).toBe("only a description");
  });
});

describe("listSkills", () => {
  it("discovers user and project skills with project precedence", async () => {
    await writeSkill(userSkillsDir(home), "shared", "---\nname: shared\ndescription: user version\n---\nuser body");
    await writeSkill(projectSkillsDir(cwd), "shared", "---\nname: shared\ndescription: project version\n---\nproject body");
    await writeSkill(userSkillsDir(home), "user-only", "---\nname: user-only\ndescription: only in user\n---\nbody");
    await writeSkill(projectSkillsDir(cwd), "proj-only", "---\nname: proj-only\ndescription: only in project\n---\nbody");

    const skills = await listSkills(cwd, home);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["proj-only", "shared", "user-only"]);
    const shared = skills.find((s) => s.name === "shared")!;
    expect(shared.description).toBe("project version");
    expect(shared.source).toBe("project");
    expect(shared.file).toContain(path.join(".node-agent", "skills", "shared", "SKILL.md"));
  });

  it("skips non-directories and directories without SKILL.md, defaulting the name", async () => {
    await fs.writeFile(path.join(userSkillsDir(home), "loose.md"), "x", "utf8");
    await fs.mkdir(path.join(userSkillsDir(home), "empty-skill"), { recursive: true });
    await writeSkill(userSkillsDir(home), "no-fm", "body only");
    const skills = await listSkills(cwd, home);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("no-fm");
    expect(skills[0].source).toBe("user");
  });

  it("returns nothing when both directories are missing", async () => {
    await fs.rm(path.join(home, ".node-agent"), { recursive: true, force: true });
    await fs.rm(path.join(cwd, ".node-agent"), { recursive: true, force: true });
    expect(await listSkills(cwd, home)).toEqual([]);
  });
});

describe("renderSkillsBlock", () => {
  it("is empty without skills and lists names otherwise", () => {
    expect(renderSkillsBlock([])).toBe("");
    const block = renderSkillsBlock([{ name: "deploy", description: "Ship it", file: "f", source: "project" }]);
    expect(block).toContain("<available_skills>");
    expect(block).toContain("- deploy: Ship it");
    expect(block).toContain("skill tool");
  });
});

describe("skill tool", () => {
  const ctx = (): ToolContext => ({ cwd, askPermission: async () => true }) as ToolContext;

  it("loads the full body of a project skill", async () => {
    await writeSkill(projectSkillsDir(cwd), "deploy", "---\nname: deploy\ndescription: Ship it\n---\nStep 1. Build.\nStep 2. Deploy.");
    const r = await skillTool.execute({ name: "deploy" }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('<skill name="deploy" source="project">');
    expect(r.content).toContain("Step 2. Deploy.");
  });

  it("reports unknown skills with the available list", async () => {
    await writeSkill(projectSkillsDir(cwd), "deploy", "---\nname: deploy\ndescription: Ship it\n---\nbody");
    const r = await skillTool.execute({ name: "no-such-skill" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no skill "no-such-skill"');
    expect(r.content).toContain("deploy");
  });

  it("reports no skills when none exist", async () => {
    const r = await skillTool.execute({ name: "anything" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("(none)");
  });
});
