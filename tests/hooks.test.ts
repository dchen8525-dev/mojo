import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HookManager, hookFileDigest, isHooksTrusted } from "../src/hooks.js";

let dir: string;
const script = (name: string, body: string) => path.join(dir, name).replaceAll("\\", "/");

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-"));
  await fs.writeFile(script("blocker.js"), 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{console.error("blocked: "+JSON.parse(s).tool_name);process.exit(2)});');
  await fs.writeFile(script("context.js"), "console.log('lint passed');");
  await fs.writeFile(script("warn.js"), 'console.error("careful");process.exit(1);');
  await fs.writeFile(script("sleeper.js"), "setTimeout(()=>{}, 30000);");
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function manager(defs: Array<string | { matcher?: string; command: string; timeout?: number; async?: boolean }>, event = "PreToolUse") {
  const hm = new HookManager();
  // Inject directly: load() reads from homedir/cwd files we do not want to touch.
  (hm as unknown as { hooks: Record<string, unknown[]> }).hooks[event] = defs.map((d) => {
    const o = typeof d === "string" ? { command: d } : d;
    return { ...o, command: `node "${o.command}"` };
  });
  return hm;
}

const payload = { cwd: process.cwd(), session_id: "test" };

describe("workspace hook trust", () => {
  const project = (cmd: string) => JSON.stringify({ PreToolUse: [{ command: cmd }] }, null, 2);

  async function workspace() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooktrust-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "proj");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(path.join(cwd, ".node-agent"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".node-agent", "hooks.json"), project(`node "${script("blocker.js")}"`), "utf8");
    return { root, home, cwd };
  }

  it("does not load project hooks until the workspace trusts them", async () => {
    const { root, home, cwd } = await workspace();
    try {
      const hm = new HookManager();
      expect(await hm.load(cwd, home)).toBe(0);
      expect(hm.untrustedProjectHooks()).not.toBeNull();
      expect(hm.list()).toEqual([]);
      // Untrusted hooks never run.
      const r = await hm.run("PreToolUse", { cwd }, "bash");
      expect(r.blocked).toBe(false);

      const digest = (await hookFileDigest(path.join(cwd, ".node-agent", "hooks.json")))!;
      await hm.trustProjectHooks(cwd, home);
      expect(await isHooksTrusted(cwd, digest, home)).toBe(true);
      expect(hm.untrustedProjectHooks()).toBeNull();
      expect(hm.list()).toHaveLength(1);
      expect((await hm.run("PreToolUse", { cwd }, "bash")).blocked).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("a trusted workspace starts a fresh manager with the hooks loaded", async () => {
    const { root, home, cwd } = await workspace();
    try {
      await new HookManager().trustProjectHooks(cwd, home);
      const hm = new HookManager();
      expect(await hm.load(cwd, home)).toBe(1);
      expect((await hm.run("PreToolUse", { cwd }, "bash")).blocked).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("editing the hooks file revokes trust (digest pinning)", async () => {
    const { root, home, cwd } = await workspace();
    try {
      const hm = new HookManager();
      await hm.trustProjectHooks(cwd, home);
      expect(hm.list()).toHaveLength(1);
      await fs.writeFile(path.join(cwd, ".node-agent", "hooks.json"), project(`node "${script("context.js")}"`), "utf8");
      expect(await hm.load(cwd, home)).toBe(0);
      expect(hm.untrustedProjectHooks()).not.toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("revoke stops project hooks from loading", async () => {
    const { root, home, cwd } = await workspace();
    try {
      const hm = new HookManager();
      await hm.trustProjectHooks(cwd, home);
      expect(await hm.revokeProjectHooks(cwd, home)).toBe(true);
      expect(hm.list()).toEqual([]);
      expect(hm.untrustedProjectHooks()).not.toBeNull();
      // Nothing left to revoke.
      expect(await hm.revokeProjectHooks(cwd, home)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("global hooks load without trust", async () => {
    const { root, home, cwd } = await workspace();
    try {
      await fs.mkdir(path.join(home, ".node-agent"), { recursive: true });
      await fs.writeFile(path.join(home, ".node-agent", "hooks.json"), project(`node "${script("context.js")}"`), "utf8");
      const hm = new HookManager();
      expect(await hm.load(cwd, home)).toBe(1); // global only; project still untrusted
      expect(hm.untrustedProjectHooks()).not.toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("HookManager.run", () => {
  it("exit 2 blocks with stderr as the reason", async () => {
    const r = await manager([script("blocker.js")]).run("PreToolUse", payload, "bash");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("blocked: bash");
  });

  it("exit 0 stdout becomes injected context", async () => {
    const r = await manager([script("context.js")]).run("PreToolUse", payload, "bash");
    expect(r.blocked).toBe(false);
    expect(r.context).toContain("lint passed");
  });

  it("other non-zero exits are warnings, not blockers", async () => {
    const r = await manager([script("warn.js")]).run("PreToolUse", payload, "bash");
    expect(r.blocked).toBe(false);
    expect(r.reason).toContain("[hook warning]");
    expect(r.reason).toContain("careful");
  });

  it("matcher restricts hooks by tool name (exact and regex)", async () => {
    const hm = manager([
      { matcher: "bash", command: script("blocker.js") },
      { matcher: "edit|write", command: script("blocker.js") },
    ]);
    expect((await hm.run("PreToolUse", payload, "read_file")).blocked).toBe(false);
    expect((await hm.run("PreToolUse", payload, "bash")).blocked).toBe(true);
    expect((await hm.run("PreToolUse", payload, "write_file")).blocked).toBe(true);
  });

  it("comma-separated matcher list", async () => {
    const hm = manager([{ matcher: "bash, grep", command: script("blocker.js") }]);
    expect((await hm.run("PreToolUse", payload, "grep")).blocked).toBe(true);
    expect((await hm.run("PreToolUse", payload, "read_file")).blocked).toBe(false);
  });

  it("timeout kills a hanging hook without blocking", async () => {
    const hm = new HookManager();
    (hm as unknown as { hooks: Record<string, unknown[]> }).hooks.PreToolUse = [
      { command: `node "${script("sleeper.js")}"`, timeout: 500 },
    ];
    const r = await hm.run("PreToolUse", payload, "bash");
    expect(r.blocked).toBe(false);
    expect(r.reason).toContain("timed out");
  });

  it("payload carries event name and tool fields on stdin", async () => {
    const hm = manager([script("blocker.js")]);
    const r = await hm.run("PreToolUse", { ...payload, tool_input: { command: "rm -rf" } }, "bash");
    // blocker echoes tool_name from the parsed stdin JSON - proves valid payload
    expect(r.reason).toContain("blocked: bash");
  });

  it("first blocker wins and later hooks are skipped", async () => {
    const hm = manager([script("context.js"), script("blocker.js"), script("context.js")]);
    const r = await hm.run("PreToolUse", payload, "bash");
    expect(r.blocked).toBe(true);
    expect(r.context).toBe("");
  });

  it("list() reports configured hooks", () => {
    const hm = manager([{ matcher: "bash", command: script("blocker.js") }]);
    const list = hm.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ event: "PreToolUse", matcher: "bash" });
  });

  it("async hooks are fire-and-forget: not awaited, no blocking, no context", async () => {
    const hm = manager([{ command: script("blocker.js"), async: true }]);
    const started = Date.now();
    const r = await hm.run("PreToolUse", payload, "bash");
    // Returned immediately even though the (sync) version of this hook blocks.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.blocked).toBe(false);
    expect(r.context).toBe("");
  });

  it("a sync blocker after an async hook still blocks", async () => {
    const hm = manager([{ command: script("context.js"), async: true }, script("blocker.js")]);
    const r = await hm.run("PreToolUse", payload, "bash");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("blocked: bash");
  });

  it("matchers are ignored on non-tool events (SessionStart/PreCompact)", async () => {
    const hm = manager([{ matcher: "bash", command: script("context.js") }], "SessionStart");
    const r = await hm.run("SessionStart", payload);
    expect(r.context).toContain("lint passed");
  });
});
