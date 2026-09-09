import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMemoryNote, projectMemoryPath, renderMemory, userMemoryPath } from "../src/memory.js";

let cwd: string;
let home: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mem-cwd-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mem-home-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe("memory paths", () => {
  it("project memory lives under .node-agent/, user memory under home", () => {
    expect(projectMemoryPath(cwd)).toBe(path.join(cwd, ".node-agent", "memory.md"));
    expect(userMemoryPath(home)).toBe(path.join(home, ".node-agent", "memory.md"));
  });
});

describe("renderMemory", () => {
  it("returns empty string when no memory files exist", async () => {
    expect(await renderMemory(cwd, home)).toBe("");
  });

  it("injects project memory with a usage preamble", async () => {
    await fs.mkdir(path.join(cwd, ".node-agent"), { recursive: true });
    await fs.writeFile(projectMemoryPath(cwd), "- always use pnpm\n", "utf8");
    const out = await renderMemory(cwd, home);
    expect(out).toContain("Long-term memory");
    expect(out).toContain("always use pnpm");
    expect(out).toContain('<project_memory file=".node-agent/memory.md"');
  });

  it("includes both user and project memory", async () => {
    await fs.mkdir(path.join(home, ".node-agent"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".node-agent"), { recursive: true });
    await fs.writeFile(userMemoryPath(home), "user prefers Chinese", "utf8");
    await fs.writeFile(projectMemoryPath(cwd), "project uses vitest", "utf8");
    const out = await renderMemory(cwd, home);
    expect(out).toContain("user prefers Chinese");
    expect(out).toContain("project uses vitest");
    expect(out).toContain("<user_memory");
    expect(out).toContain("<project_memory");
  });

  it("keeps the NEWEST tail when a file exceeds the budget", async () => {
    await fs.mkdir(path.join(cwd, ".node-agent"), { recursive: true });
    const huge = "old-stuff ".repeat(5000) + "NEWEST FACT";
    await fs.writeFile(projectMemoryPath(cwd), huge, "utf8");
    const out = await renderMemory(cwd, home);
    expect(out).toContain("NEWEST FACT"); // appended entries survive
    expect(out.length).toBeLessThan(30_000); // and the block stays bounded
  });

  it("ignores empty or whitespace-only files", async () => {
    await fs.mkdir(path.join(cwd, ".node-agent"), { recursive: true });
    await fs.writeFile(projectMemoryPath(cwd), "   \n", "utf8");
    expect(await renderMemory(cwd, home)).toBe("");
  });
});

describe("appendMemoryNote", () => {
  it("creates the file and appends dated sections", async () => {
    const p = await appendMemoryNote(cwd, "## Decisions\n- chose X because Y", "2026-09-09");
    expect(p).toBe(projectMemoryPath(cwd));
    await appendMemoryNote(cwd, "second note", "2026-09-10");
    const raw = await fs.readFile(p!, "utf8");
    expect(raw).toContain("## Session note (2026-09-09)");
    expect(raw).toContain("chose X because Y");
    expect(raw).toContain("## Session note (2026-09-10)");
    expect(raw.indexOf("2026-09-09")).toBeLessThan(raw.indexOf("2026-09-10"));
  });

  it("is best-effort: returns null when writing is impossible", async () => {
    // Make .node-agent a regular file so mkdir fails.
    await fs.mkdir(path.join(cwd, ".node-agent"), { recursive: true });
    await fs.rm(path.join(cwd, ".node-agent"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".node-agent"), "not a dir", "utf8");
    const r = await appendMemoryNote(cwd, "x", "today");
    expect(r).toBeNull();
  });
});
