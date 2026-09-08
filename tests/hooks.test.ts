import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HookManager } from "../src/hooks.js";

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

function manager(defs: Array<string | { matcher?: string; command: string; timeout?: number }>, event = "PreToolUse") {
  const hm = new HookManager();
  // Inject directly: load() reads from homedir/cwd files we do not want to touch.
  (hm as unknown as { hooks: Record<string, unknown[]> }).hooks[event] = defs.map((d) => {
    const o = typeof d === "string" ? { command: d } : d;
    return { ...o, command: `node "${o.command}"` };
  });
  return hm;
}

const payload = { cwd: process.cwd(), session_id: "test" };

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
});
