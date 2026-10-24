import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderCommand, expandFileReferences } from "../src/commands.js";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cmds-"));
  await fs.writeFile(path.join(dir, "hello.txt"), "Hello world\nline2");
  await fs.mkdir(path.join(dir, "sub"));
  await fs.writeFile(path.join(dir, "sub", "big.txt"), "x".repeat(300_000));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("renderCommand", () => {
  it("substitutes $ARGUMENTS", () => {
    expect(renderCommand("fix $ARGUMENTS please", ["src", "bug"])).toBe("fix src bug please");
  });

  it("substitutes positional $1..$9", () => {
    expect(renderCommand("$2 and $1", ["a", "b"])).toBe("b and a");
  });

  it("appends the request when the template has no placeholders", () => {
    const out = renderCommand("Review this code:", ["extra", "args"]);
    expect(out).toContain("Review this code:");
    expect(out).toContain("User request: extra args");
  });

  it("leaves template untouched with no args", () => {
    expect(renderCommand("no placeholders", [])).toBe("no placeholders");
  });
});

describe("expandFileReferences", () => {
  it("inlines a @file reference", async () => {
    const { text, files } = await expandFileReferences("look at @hello.txt please", dir);
    expect(files).toEqual(["hello.txt"]);
    expect(text).toContain('<file path="hello.txt">');
    expect(text).toContain("Hello world");
  });

  it("supports quoted paths with spaces", async () => {
    await fs.writeFile(path.join(dir, "my file.txt"), "spaced");
    const { text, files } = await expandFileReferences('read @"my file.txt"', dir);
    expect(files).toEqual(["my file.txt"]);
    expect(text).toContain("spaced");
  });

  it("leaves unknown paths and directories as literal text", async () => {
    const { text, files } = await expandFileReferences("@nope.txt and @sub", dir);
    expect(files).toEqual([]);
    expect(text).toBe("@nope.txt and @sub");
  });

  it("refuses paths outside the workspace", async () => {
    const outside = path.join(os.tmpdir(), "agent-cmds-outside.txt");
    await fs.writeFile(outside, "secret");
    try {
      const rel = "@.." + path.sep + ".." + path.sep + path.basename(outside);
      const { text } = await expandFileReferences(rel, path.join(dir, "sub"));
      expect(text).not.toContain("secret");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("expands multiple references", async () => {
    const { text, files } = await expandFileReferences("@hello.txt + @sub/big.txt", dir);
    expect(files).toHaveLength(2);
    expect(text).toContain("Hello world");
    expect(text).toContain("xxxx");
  });

  it("does not mark a file that exactly fits the inline budget as truncated", async () => {
    const exact = "y".repeat(200_000);
    await fs.writeFile(path.join(dir, "exact.txt"), exact);
    const { text } = await expandFileReferences("@exact.txt", dir);
    expect(text).toContain(exact);
    expect(text).not.toContain("[... truncated]");
  });

  it("truncates multi-byte content on a character boundary", async () => {
    await fs.writeFile(path.join(dir, "unicode.txt"), "a" + "é".repeat(150_000));
    const { text, files } = await expandFileReferences("@unicode.txt", dir);
    expect(files).toEqual(["unicode.txt"]);
    expect(text).toContain("[... truncated]");
    expect(text).not.toContain("\uFFFD");
    const body = text.slice(text.indexOf(">\n") + 2, text.indexOf("\n[... truncated]"));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(200_000);
  });

  it("leaves credential files as literal text", async () => {
    await fs.writeFile(path.join(dir, ".netrc"), "machine internal login admin password s3cret");
    try {
      const { text, files } = await expandFileReferences("look at @.netrc", dir);
      expect(files).toEqual([]);
      expect(text).toBe("look at @.netrc");
    } finally {
      await fs.rm(path.join(dir, ".netrc"), { force: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not inline a workspace symlink that escapes the repo", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cmds-outside-"));
    const link = path.join(dir, "escape.txt");
    await fs.writeFile(path.join(outside, "secret.txt"), "outside-secret");
    await fs.symlink(path.join(outside, "secret.txt"), link);
    try {
      const { text, files } = await expandFileReferences("@escape.txt", dir);
      expect(files).toEqual([]);
      expect(text).toBe("@escape.txt");
    } finally {
      await fs.rm(link, { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
