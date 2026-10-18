import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectDir, samePath } from "../src/gui/project.js";

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-project-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("resolveProjectDir", () => {
  it("accepts an existing directory and returns its realpath", async () => {
    const root = await tempDir();
    const sub = path.join(root, "sub");
    await fs.mkdir(sub);
    await expect(resolveProjectDir(sub)).resolves.toBe(await fs.realpath(sub));
  });

  it("rejects a file", async () => {
    const root = await tempDir();
    const file = path.join(root, "note.txt");
    await fs.writeFile(file, "x");
    await expect(resolveProjectDir(file)).rejects.toThrow("not a directory");
  });

  it("rejects a missing path and empty input", async () => {
    const root = await tempDir();
    await expect(resolveProjectDir(path.join(root, "nope"))).rejects.toThrow("directory not found");
    await expect(resolveProjectDir("   ")).rejects.toThrow("missing path");
  });
});

describe("samePath", () => {
  it("normalizes the same directory", () => {
    const dir = os.tmpdir();
    expect(samePath(dir, path.join(dir, "."))).toBe(true);
  });

  it("is case-insensitive on Windows only", () => {
    const a = path.join(os.tmpdir(), "MojoCase");
    const b = path.join(os.tmpdir(), "mojocase");
    expect(samePath(a, b)).toBe(process.platform === "win32");
  });

  it("distinguishes different paths", () => {
    expect(samePath(path.join(os.tmpdir(), "a"), path.join(os.tmpdir(), "b"))).toBe(false);
  });
});
