import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileTool } from "../src/tools/read.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { isReadOnlyCommand } from "../src/tools/bash.js";
import { isSensitivePath, hasOutsidePathArg } from "../src/tools/utils.js";
import type { ToolContext } from "../src/types.js";

let dir: string;

const ctx = (): ToolContext =>
  ({
    cwd: dir,
    askPermission: async () => {
      throw new Error("read-only tools must never prompt");
    },
  }) as ToolContext;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pathguard-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("isSensitivePath", () => {
  const home = os.homedir();

  it("flags credential stores and key files", () => {
    expect(isSensitivePath(path.join(home, ".ssh", "id_rsa"))).toBe(true);
    expect(isSensitivePath(path.join(home, ".ssh", "anything"))).toBe(true);
    expect(isSensitivePath(path.join(home, ".node-agent", "config.json"))).toBe(true);
    expect(isSensitivePath(path.join(home, ".aws", "credentials"))).toBe(true);
    expect(isSensitivePath(path.join(home, "project", "id_ed25519"))).toBe(true);
    expect(isSensitivePath(path.join(home, "project", ".netrc"))).toBe(true);
  });

  it("does not flag ordinary workspace paths", () => {
    expect(isSensitivePath(path.join(home, "project", "src", "main.ts"))).toBe(false);
    expect(isSensitivePath(path.join(home, "id_rsa.pub"))).toBe(false);
    expect(isSensitivePath(path.join(home, ".sshrc"))).toBe(false);
  });
});

describe("hasOutsidePathArg", () => {
  it("detects absolute, home-relative, env-expanded and parent paths", () => {
    expect(hasOutsidePathArg("cat ~/.ssh/id_rsa")).toBe(true);
    expect(hasOutsidePathArg("cat C:\\Users\\me\\.ssh\\id_rsa")).toBe(true);
    expect(hasOutsidePathArg("cat /etc/passwd")).toBe(true);
    expect(hasOutsidePathArg("cat %USERPROFILE%\\secret.txt")).toBe(true);
    expect(hasOutsidePathArg("type $env:USERPROFILE\\secret.txt")).toBe(true);
    expect(hasOutsidePathArg("ls ../other")).toBe(true);
    expect(hasOutsidePathArg("ls ..")).toBe(true);
  });

  it("leaves plain relative commands alone", () => {
    expect(hasOutsidePathArg("cat package.json")).toBe(false);
    expect(hasOutsidePathArg("git log --oneline -5")).toBe(false);
    expect(hasOutsidePathArg("DIR /b")).toBe(false);
    expect(hasOutsidePathArg("ls -la src/tools")).toBe(false);
  });

  it("keeps outside-path reads out of the read-only fast path", () => {
    expect(isReadOnlyCommand("cat ~/.ssh/id_rsa")).toBe(false);
    expect(isReadOnlyCommand("cat /etc/passwd")).toBe(false);
    expect(isReadOnlyCommand("type C:\\Windows\\win.ini")).toBe(false);
    expect(isReadOnlyCommand("cat package.json")).toBe(true);
    expect(isReadOnlyCommand("DIR /b")).toBe(true);
    expect(isReadOnlyCommand("git log --oneline -5")).toBe(true);
  });
});

describe("read_file guards", () => {
  it("refuses credential stores before touching the filesystem", async () => {
    const r = await readFileTool.execute({ path: path.join(os.homedir(), ".ssh", "id_rsa") }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("credential store");
  });

  it("refuses a file whose name is a credential file even inside the workspace", async () => {
    await fs.writeFile(path.join(dir, ".netrc"), "machine x login y password z", "utf8");
    const r = await readFileTool.execute({ path: ".netrc" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("credential store");
  });

  it("refuses directories and non-regular files", async () => {
    const r = await readFileTool.execute({ path: "." }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("directory");
  });

  it("refuses files above the read cap", async () => {
    const fh = await fs.open(path.join(dir, "huge.bin"), "w");
    await fh.truncate(17 * 1024 * 1024);
    await fh.close();
    const r = await readFileTool.execute({ path: "huge.bin" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("read cap");
  });

  it.skipIf(process.platform === "win32")("refuses a workspace symlink into a credential store", async () => {
    const ssh = path.join(os.homedir(), ".ssh");
    const planted = path.join(ssh, "mojo-pathguard-test");
    await fs.mkdir(ssh, { recursive: true });
    await fs.writeFile(planted, "x", "utf8");
    try {
      await fs.symlink(planted, path.join(dir, "notes.txt"));
      const r = await readFileTool.execute({ path: "notes.txt" }, ctx());
      expect(r.isError).toBe(true);
      expect(r.content).toContain("credential store");
    } finally {
      await fs.rm(planted, { force: true });
    }
  });
});

describe("glob_files guards", () => {
  it("rejects patterns that escape the search directory", async () => {
    for (const pattern of ["../**/*.ts", "**/../secret", "~/.ssh/*"]) {
      const r = await globTool.execute({ pattern }, ctx());
      expect(r.isError, pattern).toBe(true);
      expect(r.content).toContain("must be relative");
    }
  });

  it("rejects absolute patterns", async () => {
    const r = await globTool.execute({ pattern: path.join(os.homedir(), ".ssh", "*") }, ctx());
    expect(r.isError).toBe(true);
  });

  it("rejects searching a credential directory", async () => {
    const r = await globTool.execute({ pattern: "*", path: path.join(os.homedir(), ".ssh") }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("credential store");
  });

  it("still lists ordinary workspace files", async () => {
    await fs.writeFile(path.join(dir, "a.ts"), "", "utf8");
    const r = await globTool.execute({ pattern: "*.ts" }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("a.ts");
  });
});

describe("grep guards", () => {
  it("rejects overly long patterns", async () => {
    const r = await grepTool.execute({ pattern: "a".repeat(501) }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("longer than");
  });

  it("rejects sensitive targets without reading them", async () => {
    const r = await grepTool.execute({ pattern: "PRIVATE", path: path.join(os.homedir(), ".ssh", "id_rsa") }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("credential store");
  });

  it("rejects glob patterns that escape the searched directory", async () => {
    const r = await grepTool.execute({ pattern: "x", glob: "../**/*" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("must stay inside");
  });

  it("still searches ordinary workspace files", async () => {
    await fs.writeFile(path.join(dir, "b.ts"), "const needle = 1;\n", "utf8");
    const r = await grepTool.execute({ pattern: "needle" }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("b.ts");
  });
});
