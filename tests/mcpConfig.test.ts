import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteMcpServer,
  loadMcpConfig,
  loadMcpConfigScoped,
  normalizeMcpConfig,
  saveMcpServer,
} from "../src/mcp.js";

async function tempRoot(): Promise<{ cwd: string; home: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-mcp-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return { cwd, home };
}

describe("normalizeMcpConfig", () => {
  it("keeps command, args, env and tools", () => {
    expect(
      normalizeMcpConfig({
        command: " npx ",
        args: ["-y", "server"],
        env: { TOKEN: "x" },
        enabledTools: ["a"],
        disabledTools: ["b"],
        disabled: true,
      }),
    ).toEqual({
      command: "npx",
      args: ["-y", "server"],
      env: { TOKEN: "x" },
      enabledTools: ["a"],
      disabledTools: ["b"],
      disabled: true,
    });
  });

  it("rejects missing commands and wrong field types", () => {
    expect(() => normalizeMcpConfig({})).toThrow(/command or url is required/);
    expect(() => normalizeMcpConfig({ command: "x", args: [1] })).toThrow(/args/);
    expect(() => normalizeMcpConfig({ command: "x", env: { A: 1 } })).toThrow(/env/);
  });

  it("normalizes a remote server with headers and transport", () => {
    expect(
      normalizeMcpConfig({
        url: " https://mcp.example.com/mcp ",
        headers: { Authorization: "Bearer t" },
        type: "sse",
      }),
    ).toEqual({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer t" },
      type: "sse",
    });
    expect(normalizeMcpConfig({ url: "http://localhost:3000/mcp" })).toEqual({ url: "http://localhost:3000/mcp" });
    expect(normalizeMcpConfig({ url: "https://a.example/mcp", oauth: true })).toEqual({
      url: "https://a.example/mcp",
      oauth: true,
    });
  });

  it("rejects ambiguous or malformed remote configs", () => {
    expect(() => normalizeMcpConfig({ command: "x", url: "https://a.example" })).toThrow(/not both/);
    expect(() => normalizeMcpConfig({ url: "not a url" })).toThrow(/valid URL/);
    expect(() => normalizeMcpConfig({ url: "ftp://a.example" })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => normalizeMcpConfig({ url: "https://a.example", type: "websocket" })).toThrow(/type/);
    expect(() => normalizeMcpConfig({ url: "https://a.example", headers: { A: 1 } })).toThrow(/header values/);
    expect(() => normalizeMcpConfig({ url: "https://a.example", oauth: "yes" })).toThrow(/oauth must be a boolean/);
    expect(() => normalizeMcpConfig({ command: "x", oauth: true })).toThrow(/only valid for remote/);
  });
});

describe("MCP config files", () => {
  it("writes a wrapped config and reads both scopes", async () => {
    const { cwd, home } = await tempRoot();
    await saveMcpServer(cwd, "global", "files", { command: "npx", args: ["-y", "server-files"] }, home);

    const file = path.join(home, ".node-agent", "mcp.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    expect(raw.mcpServers.files).toEqual({ command: "npx", args: ["-y", "server-files"] });
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    const scoped = await loadMcpConfigScoped(cwd, home);
    expect(scoped.global.files.command).toBe("npx");
    expect(scoped.project).toEqual({});
  });

  it("persists a remote server", async () => {
    const { cwd, home } = await tempRoot();
    const cfg = { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" }, type: "http" as const };
    await saveMcpServer(cwd, "global", "remote", cfg, home);
    expect((await loadMcpConfigScoped(cwd, home)).global.remote).toEqual(cfg);
    expect((await loadMcpConfig(cwd, home)).remote).toEqual(cfg);
  });

  it("lets a project server override a global one and skips disabled entries", async () => {
    const { cwd, home } = await tempRoot();
    await saveMcpServer(cwd, "global", "db", { command: "global-db" }, home);
    await saveMcpServer(cwd, "project", "db", { command: "project-db" }, home);
    await saveMcpServer(cwd, "global", "off", { command: "off", disabled: true }, home);

    const enabled = await loadMcpConfig(cwd, home);
    expect(enabled.db.command).toBe("project-db");
    expect(enabled.off).toBeUndefined();

    const scoped = await loadMcpConfigScoped(cwd, home);
    expect(scoped.global.off.disabled).toBe(true);
  });

  it("deletes a server and reports misses", async () => {
    const { cwd, home } = await tempRoot();
    await saveMcpServer(cwd, "project", "one", { command: "one" }, home);
    await saveMcpServer(cwd, "project", "two", { command: "two" }, home);

    expect(await deleteMcpServer(cwd, "project", "one", home)).toBe(true);
    expect(await deleteMcpServer(cwd, "project", "one", home)).toBe(false);
    expect(Object.keys((await loadMcpConfigScoped(cwd, home)).project)).toEqual(["two"]);
  });

  it("refuses to overwrite a corrupt config file", async () => {
    const { cwd, home } = await tempRoot();
    const file = path.join(home, ".node-agent", "mcp.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json", "utf8");

    await expect(saveMcpServer(cwd, "global", "x", { command: "x" }, home)).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(file, "utf8")).toBe("{not json");
  });
});
