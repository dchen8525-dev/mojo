import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyExtraction,
  buildExtractionPrompt,
  EXTRACTION_SYSTEM,
  proposeDream,
  applyDream,
  peekDream,
  saveMemoryTool,
  scheduleMemoryJob,
  parseExtractionReply,
  upsertMemorySection,
  listMemoryHeadings,
  waitForMemoryJobs,
  type LlmLite,
} from "../src/memoryWrite.js";
import { projectMemoryPath } from "../src/memory.js";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memwrite-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("upsertMemorySection", () => {
  it("creates the file and section when missing", async () => {
    const p = await upsertMemorySection(projectMemoryPath(cwd), "build", "npm run build");
    expect(p).toBe(projectMemoryPath(cwd));
    expect(await fs.readFile(p, "utf8")).toBe("## build\nnpm run build\n");
  });

  it("appends under an existing heading and before the next section", async () => {
    const file = projectMemoryPath(cwd);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "## build\nold note\n\n## deploy\nship it\n", "utf8");
    await upsertMemorySection(file, "build", "new note");
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain("## build\nold note\nnew note\n\n## deploy");
    expect(text.indexOf("new note")).toBeLessThan(text.indexOf("## deploy"));
  });

  it("skips an exact duplicate", async () => {
    const file = projectMemoryPath(cwd);
    await upsertMemorySection(file, "build", "npm run build");
    await upsertMemorySection(file, "build", "npm run build");
    expect(await fs.readFile(file, "utf8")).toBe("## build\nnpm run build\n");
  });

  it("normalizes heading whitespace and collapsing blank runs", async () => {
    const file = projectMemoryPath(cwd);
    await upsertMemorySection(file, "  build   system  ", "a\n\n\n\nb");
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain("## build system\na\n\nb\n");
    // A later upsert with the cleaned heading finds the same section.
    await upsertMemorySection(file, "build system", "c");
    expect(await listMemoryHeadings(file)).toEqual(["build system"]);
  });

  it.skipIf(process.platform === "win32")("refuses to write through a planted symlink", async () => {
    const target = path.join(cwd, "victim.ts");
    await fs.writeFile(target, "real file", "utf8");
    await fs.symlink(target, projectMemoryPath(cwd));
    expect(await upsertMemorySection(projectMemoryPath(cwd), "h", "n")).toBeNull();
    expect(await fs.readFile(target, "utf8")).toBe("real file");
  });
});

describe("listMemoryHeadings", () => {
  it("returns level-2 headings and tolerates a missing file", async () => {
    expect(await listMemoryHeadings(projectMemoryPath(cwd))).toEqual([]);
    await fs.mkdir(path.dirname(projectMemoryPath(cwd)), { recursive: true });
    await fs.writeFile(projectMemoryPath(cwd), "# top\n## a\nx\n### deep\n## b\n", "utf8");
    expect(await listMemoryHeadings(projectMemoryPath(cwd))).toEqual(["a", "b"]);
  });
});

describe("saveMemoryTool", () => {
  const ctx = (perms: boolean[]) => ({ cwd, askPermission: async () => perms.shift() ?? false }) as never;

  it("rejects an empty note without asking", async () => {
    const r = await saveMemoryTool.execute({ note: "   " }, ctx([true]));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("note must not be empty");
  });

  it("writes to project memory after permission is granted", async () => {
    const r = await saveMemoryTool.execute({ heading: "conventions", note: "use vitest" }, ctx([true]));
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Saved to");
    expect(await fs.readFile(projectMemoryPath(cwd), "utf8")).toContain("use vitest");
  });

  it("declines without permission and writes nothing", async () => {
    const r = await saveMemoryTool.execute({ note: "secret fact" }, ctx([false]));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("declined");
    await expect(fs.access(projectMemoryPath(cwd))).rejects.toThrow();
  });
});

describe("parseExtractionReply", () => {
  it("extracts a JSON array embedded in prose", () => {
    const out = parseExtractionReply('Sure, here you go:\n[{"heading":"build","note":"npm run build"}]\nDone.');
    expect(out).toEqual([{ heading: "build", note: "npm run build" }]);
  });

  it("returns [] for empty arrays, invalid JSON, and non-arrays", () => {
    expect(parseExtractionReply("[]")).toEqual([]);
    expect(parseExtractionReply("no brackets here")).toEqual([]);
    expect(parseExtractionReply("[{broken")).toEqual([]);
    expect(parseExtractionReply('{"heading":"h"}')).toEqual([]);
  });

  it("skips entries without a note and caps at 5", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ heading: `h${i}`, note: `n${i}` }));
    const out = parseExtractionReply(JSON.stringify(items));
    expect(out.length).toBe(5);
    expect(parseExtractionReply('[{"heading":"h"},{"heading":"h","note":"  "}]')).toEqual([]);
  });
});

describe("buildExtractionPrompt", () => {
  it("lists headings and clips long sides", () => {
    const p = buildExtractionPrompt("u".repeat(7000), "a", ["h1", "h2"]);
    expect(p).toContain("- h1\n- h2");
    expect(p).toContain("<user>");
    expect(p).toContain("…[truncated]");
    expect(EXTRACTION_SYSTEM).toContain("JSON array");
  });
});

describe("scheduleMemoryJob", () => {
  it("runs jobs serially and collapses pending ones to the latest", async () => {
    const order: string[] = [];
    let release1: () => void = () => {};
    const gate1 = new Promise<void>((r) => (release1 = r));
    scheduleMemoryJob(async () => {
      order.push("a-start");
      await gate1;
      order.push("a-end");
    });
    await vi.waitFor(() => expect(order).toContain("a-start"));
    scheduleMemoryJob(async () => order.push("b1"));
    scheduleMemoryJob(async () => order.push("b2"));
    release1();
    await waitForMemoryJobs();
    expect(order).toEqual(["a-start", "a-end", "b2"]);
  });

  it("swallows job errors", async () => {
    scheduleMemoryJob(async () => {
      throw new Error("boom");
    });
    await waitForMemoryJobs();
    const ran: boolean[] = [];
    scheduleMemoryJob(async () => ran.push(true));
    await waitForMemoryJobs();
    expect(ran).toEqual([true]);
  });
});

describe("applyExtraction", () => {
  it("upserts entries into the project memory file", async () => {
    const applied = await applyExtraction(cwd, [{ heading: "build", note: "npm test" }], "2026-10-22");
    expect(applied).toEqual([path.join(".node-agent", "memory.md") + " → ## build (2026-10-22)"]);
    expect(await fs.readFile(projectMemoryPath(cwd), "utf8")).toContain("npm test");
  });
});

function fakeLlm(reply: string | Error): LlmLite {
  return {
    send: async () => {
      if (reply instanceof Error) throw reply;
      return { content: [{ type: "text", text: reply }], inputTokens: 10, outputTokens: 20 };
    },
  };
}

describe("dream round-trip", () => {
  it("propose writes a proposal, peek previews it, apply swaps with a backup", async () => {
    const file = projectMemoryPath(cwd);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "## old\nstale note\n", "utf8");
    const p = await proposeDream(cwd, fakeLlm("## new\nmerged note"));
    expect(p).toBe(path.join(cwd, ".node-agent", "memory.dream.md"));

    const peek = await peekDream(cwd);
    expect(peek).not.toBeNull();
    expect(peek!.lines).toBe(3); // trailing newline counted
    expect(peek!.preview).toContain("merged note");

    const report = await applyDream(cwd);
    expect(report).toContain(".bak");
    expect(await fs.readFile(file, "utf8")).toContain("merged note");
    expect(await fs.readFile(file + ".bak", "utf8")).toContain("stale note");
    await expect(fs.access(p!)).rejects.toThrow(); // proposal consumed
  });

  it("propose returns null on empty memory or a failed model call", async () => {
    expect(await proposeDream(cwd, fakeLlm("## new\nmerged note"))).toBeNull();
    await fs.mkdir(path.dirname(projectMemoryPath(cwd)), { recursive: true });
    await fs.writeFile(projectMemoryPath(cwd), "## old\nstale\n", "utf8");
    expect(await proposeDream(cwd, fakeLlm(new Error("rate limited")))).toBeNull();
    expect(await peekDream(cwd)).toBeNull();
    expect(await applyDream(cwd)).toBeNull();
  });
});
