import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEdits, diffStats, findAll, findFuzzyEdits, nearestMiss, renderDiff } from "../src/tools/editMatch.js";
import { editFileTool } from "../src/tools/write.js";
import { configureLsp } from "../src/lsp.js";
import type { ToolContext } from "../src/types.js";

describe("editMatch primitives", () => {
  it("findAll returns every exact offset", () => {
    expect(findAll("a.b.b.", "b")).toEqual([2, 4]);
    expect(findAll("abc", "zz")).toEqual([]);
  });

  it("fuzzy match ignores indentation differences and re-indents the replacement", () => {
    const file = "function f() {\n    return 1;\n}\n";
    // Model sends the line with no indent.
    const { edits, note } = findFuzzyEdits(file, "return 1;", "return 2;");
    expect(edits).toHaveLength(1);
    expect(note).toContain("re-indented");
    const out = applyEdits(file, edits);
    expect(out).toBe("function f() {\n    return 2;\n}\n");
  });

  it("fuzzy match handles multi-line windows with shifted indent", () => {
    const file = "if (x) {\n\t\ta();\n\t\tb();\n}\n";
    const { edits } = findFuzzyEdits(file, "  a();\n  b();", "  c();");
    expect(edits).toHaveLength(1);
    // File indent is 2 tabs (8 cols), old had 2 spaces: the replacement is
    // re-indented to 8 columns (delta 6 + the 2 it already carried).
    const out = applyEdits(file, edits);
    expect(out).toBe("if (x) {\n        c();\n}\n");
  });

  it("fuzzy match preserves CRLF files", () => {
    const file = "one\r\n  two ERROR\r\nthree\r\n";
    const { edits } = findFuzzyEdits(file, "two ERROR", "two fine");
    const out = applyEdits(file, edits);
    expect(out).toBe("one\r\n  two fine\r\nthree\r\n");
  });

  it("nearestMiss reports the best partial region", () => {
    const file = "a\nb\nc\nd\n";
    const miss = nearestMiss(file, "c\nddx");
    expect(miss).not.toBeNull();
    expect(miss!.line).toBe(3);
    expect(miss!.snippet).toContain("3\tc");
  });

  it("nearestMiss returns null when nothing overlaps", () => {
    expect(nearestMiss("a\nb\n", "zzz\nyyy")).toBeNull();
  });

  it("renderDiff emits one hunk with context and correct line numbers", () => {
    const file = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n";
    const hits = findAll(file, "line10");
    const edits = hits.map((s) => ({ start: s, end: s + "line10".length, text: "CHANGED" }));
    const diff = renderDiff(file, edits);
    expect(diff).toContain("@@ -8,7 +8,7 @@");
    expect(diff).toContain("-line10");
    expect(diff).toContain("+CHANGED");
    expect(diff).toContain(" line9");
    expect(diff).toContain(" line11");
  });

  it("renderDiff handles multiple hunks and an empty replacement (delete)", () => {
    const file = "aa\nbb\ncc\ndd\nee\n";
    const edits = [
      { start: 0, end: 2, text: "AA" },
      { start: 9, end: 11, text: "" },
    ];
    const diff = renderDiff(file, edits);
    expect(diff).toContain("+AA");
    expect(diff).toContain("-dd");
    const applied = applyEdits(file, edits);
    expect(applied).toBe("AA\nbb\ncc\n\nee\n");
  });

  it("diffStats counts added and removed lines", () => {
    const file = "one\ntwo\n";
    const edits = [{ start: 4, end: 7, text: "2\n3\n4" }];
    expect(diffStats(edits, file)).toBe("+3/-1 lines");
  });
});

describe("edit_file tool behaviour", () => {
  let dir: string;
  let asked: Array<{ desc: string; preview?: string }>;
  let ctx: ToolContext;

  beforeEach(async () => {
    configureLsp(dir ?? ".", { enabled: false }); // no LSP in these tests
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-edit-"));
    asked = [];
    ctx = {
      get cwd() {
        return dir;
      },
      askPermission: async (desc, _risk, preview) => {
        asked.push({ desc, preview });
        return true;
      },
    };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("exact match applies and the result carries a diff", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "hello world\n", "utf8");
    const r = await editFileTool.execute({ path: "a.txt", old_string: "hello", new_string: "bye" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("<diff>");
    expect(r.content).toContain("-hello world");
    expect(r.content).toContain("+bye world");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("bye world\n");
  });

  it("wrong indentation still matches via the fuzzy fallback", async () => {
    // No exact substring exists across the two indented lines, so only the
    // whitespace-insensitive line-window match can succeed.
    await fs.writeFile(path.join(dir, "b.txt"), "  foo();\n  bar();\n", "utf8");
    const r = await editFileTool.execute(
      { path: "b.txt", old_string: "foo();\nbar();", new_string: "baz();\nqux();" },
      ctx,
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("ignoring whitespace");
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe("  baz();\n  qux();\n");
  });

  it("ambiguous match fails and lists the matching lines", async () => {
    await fs.writeFile(path.join(dir, "c.txt"), "dup\nx\ndup\ny\ndup\n", "utf8");
    const r = await editFileTool.execute({ path: "c.txt", old_string: "dup", new_string: "z" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("matches 3 places");
    expect(r.content).toContain("lines 1, 3, 5");
  });

  it("replace_all edits every occurrence", async () => {
    await fs.writeFile(path.join(dir, "d.txt"), "cat dog cat\n", "utf8");
    const r = await editFileTool.execute({ path: "d.txt", old_string: "cat", new_string: "fox", replace_all: true }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("2 replacements");
    expect(await fs.readFile(path.join(dir, "d.txt"), "utf8")).toBe("fox dog fox\n");
  });

  it("not-found failure shows the closest region so the model can retry", async () => {
    await fs.writeFile(path.join(dir, "e.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const r = await editFileTool.execute({ path: "e.txt", old_string: "betaa\ngam", new_string: "x" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("closest region starts at line 2");
    expect(r.content).toContain("2\tbeta");
    expect(r.content).toContain("3\tgamma");
  });

  it("permission prompt receives the diff as preview, not in the description", async () => {
    await fs.writeFile(path.join(dir, "f.txt"), "one\ntwo\n", "utf8");
    await editFileTool.execute({ path: "f.txt", old_string: "two", new_string: "three" }, ctx);
    expect(asked).toHaveLength(1);
    expect(asked[0].desc).toContain("+1/-1 lines");
    expect(asked[0].desc).not.toContain("\n");
    expect(asked[0].preview).toContain("+three");
  });

  it("delete edit (empty new_string) works", async () => {
    await fs.writeFile(path.join(dir, "g.txt"), "keep\ndrop\nkeep2\n", "utf8");
    const r = await editFileTool.execute({ path: "g.txt", old_string: "drop\n", new_string: "" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(await fs.readFile(path.join(dir, "g.txt"), "utf8")).toBe("keep\nkeep2\n");
  });
});
