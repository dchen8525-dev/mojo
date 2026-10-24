import { describe, expect, it } from "vitest";
import { derivePatchedContent, parseStructuredPatch } from "../src/patch.js";

describe("parseStructuredPatch", () => {
  it("parses add / delete / update sections", () => {
    const sections = parseStructuredPatch(
      [
        "*** Begin Patch",
        "*** Add File: new.ts",
        "+export const a = 1;",
        "+export const b = 2;",
        "*** Delete File: old.ts",
        "*** Update File: mid.ts",
        "@@ const x",
        " const x = 1;",
        "-const y = 2;",
        "+const y = 3;",
        "*** End Patch",
      ].join("\n"),
    );
    expect(sections).toHaveLength(3);
    expect(sections[0]).toEqual({ type: "add", path: "new.ts", contents: "export const a = 1;\nexport const b = 2;\n" });
    expect(sections[1]).toEqual({ type: "delete", path: "old.ts" });
    const update = sections[2]!;
    if (update.type !== "update") throw new Error("expected update");
    expect(update.path).toBe("mid.ts");
    expect(update.chunks).toEqual([
      {
        oldLines: ["const x = 1;", "const y = 2;"],
        newLines: ["const x = 1;", "const y = 3;"],
        changeContext: "const x",
        endOfFile: false,
      },
    ]);
  });

  it("parses Move to and End of File", () => {
    const sections = parseStructuredPatch(
      [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "*** Move to: b.ts",
        "@@",
        "-last",
        "+renamed",
        "*** End of File",
        "*** End Patch",
      ].join("\n"),
    );
    const update = sections[0]!;
    if (update.type !== "update") throw new Error("expected update");
    expect(update.movePath).toBe("b.ts");
    expect(update.chunks[0].endOfFile).toBe(true);
  });

  it("strips a heredoc wrapper around the patch", () => {
    const wrapped = ["cat <<'EOF'", "*** Begin Patch", "*** Add File: x.ts", "+hi", "*** End Patch", "EOF"].join("\n");
    const sections = parseStructuredPatch(wrapped);
    expect(sections[0]).toMatchObject({ type: "add", path: "x.ts" });
  });

  it("ignores content after the first End marker and throws without markers", () => {
    // The first *** End Patch closes the patch; a later stray line is outside it.
    expect(parseStructuredPatch("*** Begin Patch\n*** End Patch\nnope\n*** End Patch")).toEqual([]);
    expect(() => parseStructuredPatch("*** Add File: x.ts\n+hi")).toThrow(/Begin\/End markers/);
    expect(() => parseStructuredPatch("*** Begin Patch\n*** Add File: \n*** End Patch")).toThrow(/Missing path/);
  });

  it("rejects bare lines inside an Add section", () => {
    expect(() => parseStructuredPatch("*** Begin Patch\n*** Add File: x.ts\nhi\n*** End Patch")).toThrow(/Invalid add file line/);
  });
});

describe("derivePatchedContent", () => {
  it("applies a context hunk in the middle of the file", () => {
    const content = "one\ntwo\nthree\nfour\n";
    const out = derivePatchedContent(content, [
      { oldLines: ["two", "three"], newLines: ["two", "trois"] },
    ]).content;
    expect(out).toBe("one\ntwo\ntrois\nfour\n");
  });

  it("appends when the hunk has no old lines", () => {
    const out = derivePatchedContent("a\n", [{ oldLines: [], newLines: ["b", "c"] }]).content;
    expect(out).toBe("a\nb\nc\n");
  });

  it("anchors an End of File hunk to the last lines", () => {
    const content = "a\nend\n";
    const out = derivePatchedContent(content, [{ oldLines: ["end"], newLines: ["end", "tail"], endOfFile: true }]).content;
    expect(out).toBe("a\nend\ntail\n");
  });

  it("matches with trimEnd leniency (trailing whitespace)", () => {
    const out = derivePatchedContent("x = 1   \ny = 2\n", [{ oldLines: ["x = 1"], newLines: ["x = 10"] }]).content;
    expect(out).toBe("x = 10\ny = 2\n");
  });

  it("matches curly quotes against straight quotes via unicode normalization", () => {
    const out = derivePatchedContent("say “hello” — ok\n", [{ oldLines: ["say \"hello\" - ok"], newLines: ["say \"bye\" - ok"] }]).content;
    expect(out).toBe("say \"bye\" - ok\n");
  });

  it("uses the changeContext anchor when hunks repeat", () => {
    const content = "fn a():\n  return 1\n\nfn b():\n  return 1\n";
    const out = derivePatchedContent(content, [
      { oldLines: ["  return 1"], newLines: ["  return 2"], changeContext: "fn b():" },
    ]).content;
    expect(out).toBe("fn a():\n  return 1\n\nfn b():\n  return 2\n");
  });

  it("trims a trailing blank pattern line before retrying", () => {
    const out = derivePatchedContent("a\nb\n", [{ oldLines: ["a", ""], newLines: ["a", "b2", ""] }]).content;
    expect(out).toBe("a\nb2\nb\n");
  });

  it("throws when the context anchor or pattern is absent", () => {
    expect(() => derivePatchedContent("a\n", [{ oldLines: ["zzz"], newLines: [] }])).toThrow(/Failed to find expected lines/);
    expect(() => derivePatchedContent("a\n", [{ oldLines: [], newLines: ["x"] as never, changeContext: "zzz" }])).toThrow(/Failed to find context/);
  });

  it("inserts an anchored hunk after the context line instead of appending", () => {
    const out = derivePatchedContent("h1\ninsert here\nh2\n", [
      { oldLines: [], newLines: ["new line"], changeContext: "insert here" },
    ]).content;
    expect(out).toBe("h1\ninsert here\nnew line\nh2\n");
  });
});
