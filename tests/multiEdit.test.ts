import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/types.js";
import { multiEditTool, computeEdits } from "../src/tools/multiEdit.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-multiedit-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  cwd: dir,
  askPermission: async () => true,
  ...overrides,
});

async function put(rel: string, content: string) {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

describe("computeEdits", () => {
  it("finds all literal occurrences", () => {
    const edits = computeEdits("a.foo b.foo c.foo", "foo", "bar", false);
    expect(edits).toHaveLength(3);
  });

  it("expands regex capture groups", () => {
    const edits = computeEdits("let x = 1; let y = 2;", "let (\\w) = ", "const $1 = ", true);
    expect(edits).toHaveLength(2);
    expect(edits[0].text).toBe("const x = ");
  });

  it("does not loop forever on zero-length regex matches", () => {
    // "a*" matches "a" at 0, then empty strings at 1..3; the guard must skip
    // the zero-length ones and terminate.
    const edits = computeEdits("abc", "a*", "Y", true);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ start: 0, end: 1, text: "Y" });
  });
});

describe("multi_edit tool", () => {
  it("replaces across files with one confirmation and writes them", async () => {
    await put("src/a.ts", "import { x } from './old';\n");
    await put("src/b.ts", "import { y } from './old';\nimport { z } from './old';\n");
    await put("src/keep.ts", "no change here\n");
    const ask = vi.fn(async () => true);
    const r = await multiEditTool.execute(
      { pattern: "src/**/*.ts", search: "'./old'", replacement: "'./new'" },
      ctx({ askPermission: ask }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("3 replacements in 2 files");
    expect(ask).toHaveBeenCalledTimes(1); // ONE prompt for the whole batch
    expect(await fs.readFile(path.join(dir, "src/a.ts"), "utf8")).toContain("'./new'");
    expect(await fs.readFile(path.join(dir, "src/b.ts"), "utf8")).toContain("'./new'");
    expect(await fs.readFile(path.join(dir, "src/b.ts"), "utf8")).not.toContain("./old");
    expect(await fs.readFile(path.join(dir, "src/keep.ts"), "utf8")).toBe("no change here\n");
  });

  it("supports regex with capture groups", async () => {
    await put("m.ts", "var a = 1;\nvar b = 2;\n");
    const r = await multiEditTool.execute(
      { pattern: "*.ts", search: "^var (\\w+)", replacement: "let $1", use_regex: true },
      ctx(),
    );
    expect(r.content).toContain("2 replacements");
    const out = await fs.readFile(path.join(dir, "m.ts"), "utf8");
    expect(out).toBe("let a = 1;\nlet b = 2;\n");
  });

  it("dry_run writes nothing and skips the prompt", async () => {
    await put("d.ts", "foo foo\n");
    const ask = vi.fn(async () => true);
    const r = await multiEditTool.execute(
      { pattern: "*.ts", search: "foo", replacement: "bar", dry_run: true },
      ctx({ askPermission: ask }),
    );
    expect(r.content).toContain("dry run");
    expect(r.content).toContain("2 replacements");
    expect(ask).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(dir, "d.ts"), "utf8")).toBe("foo foo\n");
  });

  it("nothing is written when the user rejects", async () => {
    await put("r.ts", "alpha\n");
    const r = await multiEditTool.execute(
      { pattern: "*.ts", search: "alpha", replacement: "omega" },
      ctx({ askPermission: async () => false }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("rejected");
    expect(await fs.readFile(path.join(dir, "r.ts"), "utf8")).toBe("alpha\n");
  });

  it("checkpoints every file it touches (undoable)", async () => {
    await put("c1.ts", "x\n");
    await put("c2.ts", "x\n");
    const checkpoint = vi.fn(async () => {});
    await multiEditTool.execute({ pattern: "*.ts", search: "x", replacement: "y" }, ctx({ checkpoint }));
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(checkpoint.mock.calls.map((c) => c[1])).toEqual(["multi_edit", "multi_edit"]);
  });

  it("skips binary files and reports them", async () => {
    await put("ok.ts", "hello\n");
    await fs.writeFile(path.join(dir, "bin.dat"), Buffer.from([0x68, 0x00, 0x65])); // contains NUL
    const r = await multiEditTool.execute({ pattern: "*", search: "hello", replacement: "hi" }, ctx());
    expect(r.content).toContain("1 replacement in 1 file");
    expect(r.content).toContain("1 binary/oversized skipped");
  });

  it("reports no matches without prompting", async () => {
    await put("n.ts", "content\n");
    const ask = vi.fn(async () => true);
    const r = await multiEditTool.execute({ pattern: "*.ts", search: "absent", replacement: "x" }, ctx({ askPermission: ask }));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("No matches");
    expect(ask).not.toHaveBeenCalled();
  });

  it("rejects an invalid regex up front", async () => {
    const r = await multiEditTool.execute(
      { pattern: "*.ts", search: "([unclosed", replacement: "x", use_regex: true },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("invalid regex");
  });

  it("errors when the glob matches nothing", async () => {
    const r = await multiEditTool.execute({ pattern: "nope/**/*.ts", search: "a", replacement: "b" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("No files match");
  });
});
