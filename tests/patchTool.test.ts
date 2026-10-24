import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/types.js";
import { FileStateStore } from "../src/fileState.js";
import { CheckpointStore } from "../src/checkpoint.js";
import { readFileTool } from "../src/tools/read.js";
import { applyPatchTool } from "../src/tools/patch.js";

let dir: string;
let fileState: FileStateStore;

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    cwd: dir,
    askPermission: async () => true,
    fileState,
    ...overrides,
  }) as ToolContext;

const file = (name: string) => path.join(dir, name);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-applypatch-"));
  fileState = new FileStateStore();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function patch(...lines: string[]): Record<string, unknown> {
  return { patch: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") };
}

describe("apply_patch tool", () => {
  it("adds, updates, moves and deletes files in one call", async () => {
    await fs.writeFile(file("mid.ts"), "const x = 1;\nconst y = 2;\n", "utf8");
    await fs.writeFile(file("gone.ts"), "bye\n", "utf8");
    await readFileTool.execute({ path: "mid.ts" }, ctx());
    await readFileTool.execute({ path: "gone.ts" }, ctx());
    const ask = vi.fn(async () => true);
    const r = await applyPatchTool.execute(
      patch(
        "*** Add File: new.ts",
        "+export const a = 1;",
        "*** Update File: mid.ts",
        "*** Move to: renamed.ts",
        "@@ const x = 1;",
        "-const y = 2;",
        "+const y = 3;",
        "+// moved",
        "*** Delete File: gone.ts",
      ),
      ctx({ askPermission: ask }),
    );
    expect(r.isError).toBeFalsy();
    expect(await fs.readFile(file("new.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await fs.readFile(file("renamed.ts"), "utf8")).toBe("const x = 1;\nconst y = 3;\n// moved\n");
    await expect(fs.access(file("mid.ts"))).rejects.toThrow();
    await expect(fs.access(file("gone.ts"))).rejects.toThrow();
    // One permission ask per affected path: new.ts, renamed.ts (move target), gone.ts
    expect(ask).toHaveBeenCalledTimes(3);
    const requests = ask.mock.calls.map((c) => c[3]);
    expect(requests).toContainEqual({ tool: "apply_patch", values: ["new.ts"] });
    expect(requests).toContainEqual({ tool: "apply_patch", values: ["renamed.ts"] });
    expect(requests).toContainEqual({ tool: "apply_patch", values: ["gone.ts"] });
    expect(r.content).toContain("Patch applied.");
    expect(r.content).toContain("A new.ts (+1/-0)");
    expect(r.content).toContain("M mid.ts -> renamed.ts");
    expect(r.content).toContain("D gone.ts (-1)");
  });

  it("denial aborts the whole patch before anything is written", async () => {
    await fs.writeFile(file("keep.ts"), "original\n", "utf8");
    await readFileTool.execute({ path: "keep.ts" }, ctx());
    const r = await applyPatchTool.execute(
      patch("*** Add File: never.ts", "+nope", "*** Update File: keep.ts", "@@", "-original", "+changed"),
      ctx({ askPermission: async () => false }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("rejected");
    await expect(fs.access(file("never.ts"))).rejects.toThrow();
    expect(await fs.readFile(file("keep.ts"), "utf8")).toBe("original\n");
  });

  it("blocks update and delete when the file was not read", async () => {
    await fs.writeFile(file("unread.ts"), "x\n", "utf8");
    const r = await applyPatchTool.execute(
      patch("*** Update File: unread.ts", "@@", "-x", "+y", "*** Delete File: unread.ts"),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("has not been read");
    expect(await fs.readFile(file("unread.ts"), "utf8")).toBe("x\n");
  });

  it("reports a hunk that matches nothing without touching the file", async () => {
    await fs.writeFile(file("f.ts"), "alpha\nbeta\n", "utf8");
    await readFileTool.execute({ path: "f.ts" }, ctx());
    const r = await applyPatchTool.execute(
      patch("*** Update File: f.ts", "@@", "-gamma", "+delta"),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Failed to find expected lines");
    expect(await fs.readFile(file("f.ts"), "utf8")).toBe("alpha\nbeta\n");
  });

  it("refuses to add a file that already exists", async () => {
    await fs.writeFile(file("dup.ts"), "x\n", "utf8");
    const r = await applyPatchTool.execute(patch("*** Add File: dup.ts", "+x"), ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("already exists");
  });

  it("refuses a move onto itself instead of deleting the source", async () => {
    await fs.writeFile(file("self.ts"), "x\n", "utf8");
    await readFileTool.execute({ path: "self.ts" }, ctx());
    const r = await applyPatchTool.execute(
      patch("*** Update File: self.ts", "*** Move to: self.ts", "@@", "-x", "+y"),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("onto itself");
    expect(await fs.readFile(file("self.ts"), "utf8")).toBe("x\n");
  });

  it("refuses to move onto an existing file without reading it", async () => {
    await fs.writeFile(file("src.ts"), "source\n", "utf8");
    await fs.writeFile(file("target.ts"), "keep me\n", "utf8");
    await readFileTool.execute({ path: "src.ts" }, ctx());
    const r = await applyPatchTool.execute(
      patch("*** Update File: src.ts", "*** Move to: target.ts", "@@", "-source", "+moved"),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Move target already exists");
    expect(await fs.readFile(file("target.ts"), "utf8")).toBe("keep me\n");
    expect(await fs.readFile(file("src.ts"), "utf8")).toBe("source\n");
  });

  it("rejects two sections that touch the same path", async () => {
    await fs.writeFile(file("both.ts"), "x\n", "utf8");
    await readFileTool.execute({ path: "both.ts" }, ctx());
    const r = await applyPatchTool.execute(
      patch(
        "*** Update File: both.ts",
        "@@",
        "-x",
        "+y",
        "*** Delete File: both.ts",
      ),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("conflicting patch sections");
    expect(await fs.readFile(file("both.ts"), "utf8")).toBe("x\n");
  });

  it("rejects duplicate sections and empty patches", async () => {
    const dup = await applyPatchTool.execute(
      patch("*** Add File: a.ts", "+1", "*** Add File: a.ts", "+2"),
      ctx(),
    );
    expect(dup.isError).toBe(true);
    expect(dup.content).toContain("duplicate add section");

    const empty = await applyPatchTool.execute({ patch: "*** Begin Patch\n*** End Patch" }, ctx());
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain("no file sections");

    const bad = await applyPatchTool.execute({ patch: "not a patch" }, ctx());
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("Begin/End markers");
  });

  it("records read state after writes so later hunks still pass the guard", async () => {
    const r = await applyPatchTool.execute(patch("*** Add File: tracked.ts", "+one"), ctx());
    expect(r.isError).toBeFalsy();
    const blocked = await fileState.check(path.join(dir, "tracked.ts"));
    expect(blocked).toBeNull();
  });

  it("undo after a move restores the source and removes the moved copy", async () => {
    await fs.writeFile(file("mid.ts"), "const x = 1;\n", "utf8");
    await readFileTool.execute({ path: "mid.ts" }, ctx());
    const store = new CheckpointStore("patch-move", path.join(dir, "checkpoints"));
    const checkpoint: NonNullable<ToolContext["checkpoint"]> = async (abs, label, opts) => {
      const entry = await store.capture(abs, label, opts);
      return entry ? { finalize: () => store.finalize(entry) } : undefined;
    };
    const r = await applyPatchTool.execute(
      patch("*** Update File: mid.ts", "*** Move to: renamed.ts", "@@", "-const x = 1;", "+const x = 2;"),
      ctx({ checkpoint }),
    );
    expect(r.isError).toBeFalsy();

    const undo = await store.undoLast();
    expect(undo?.conflict).toBeFalsy();
    expect(undo?.action).toContain("restored");
    expect(await fs.readFile(file("mid.ts"), "utf8")).toBe("const x = 1;\n");
    await expect(fs.access(file("renamed.ts"))).rejects.toThrow();
  });

  it("includes @@ preview headers in the permission request", async () => {
    await fs.writeFile(file("p.ts"), "old line\n", "utf8");
    await readFileTool.execute({ path: "p.ts" }, ctx());
    const ask = vi.fn(async () => true);
    await applyPatchTool.execute(
      patch("*** Update File: p.ts", "@@", "-old line", "+new line"),
      ctx({ askPermission: ask }),
    );
    const [description, risk, preview] = ask.mock.calls[0]!;
    expect(risk).toBe("high");
    expect(description).toContain("Edit p.ts: 1 hunk (1+/-1)");
    expect(preview).toContain("@@ p.ts");
    expect(preview).toContain("-old line");
    expect(preview).toContain("+new line");
  });
});
