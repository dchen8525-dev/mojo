import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PermissionManager, loadRulesFrom, ruleMatches } from "../src/permissions.js";
import type { Risk } from "../src/types.js";

describe("ruleMatches", () => {
  it("matches substrings without a wildcard", () => {
    expect(ruleMatches("rm -rf /", "Allowed rm -rf /")).toBe(true);
    expect(ruleMatches("npm install", "Run npm run build")).toBe(false);
  });

  it("matches a '*' wildcard as an anchored glob", () => {
    expect(ruleMatches("git status", "Run git status")).toBe(true);
    expect(ruleMatches("git *", "Run git status --porcelain")).toBe(true);
    expect(ruleMatches("git tag*", "Run git status")).toBe(false);
    expect(ruleMatches("read_file *", "Run read_file src/a.ts")).toBe(true);
    expect(ruleMatches("bash: npm run *", "Run bash: npm run test")).toBe(true);
    expect(ruleMatches("bash: npm *", "bash: npm run x && rm -rf /")).toBe(true);
  });

  it("never throws on pathological patterns", () => {
    expect(ruleMatches("a[", "anything")).toBe(false);
    expect(ruleMatches("", "x")).toBe(true); // "" is a substring of everything
  });
});

describe("loadRulesFrom", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-perm-"));
  });

  it("returns [] for a missing file", async () => {
    expect(await loadRulesFrom(path.join(dir, "nope.json"))).toEqual([]);
  });

  it("parses valid rules and drops junk entries", async () => {
    const file = path.join(dir, "ok.json");
    await fs.writeFile(file, JSON.stringify([
      { match: "git status", decision: "allow" },
      { match: "rm", decision: "deny" },
      { match: 42, decision: "allow" },
      { match: "x", decision: "maybe" },
      { match: "y" },
    ]), "utf8");
    expect(await loadRulesFrom(file)).toEqual([
      { match: "git status", decision: "allow" },
      { match: "rm", decision: "deny" },
    ]);
  });

  it("tolerates a UTF-8 BOM", async () => {
    const file = path.join(dir, "bom.json");
    await fs.writeFile(file, "\uFEFF[]", "utf8");
    expect(await loadRulesFrom(file)).toEqual([]);
  });
});

describe("PermissionManager project rules", () => {
  let askCalls = 0;
  const askUser = async (_d: string, _r: Risk): Promise<"yes"> => {
    askCalls++;
    return "yes";
  };

  beforeEach(() => {
    askCalls = 0;
  });

  it("lets a project allow-rule skip the prompt (wildcard)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-proj-"));
    await fs.mkdir(path.join(tmp, ".node-agent"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".node-agent", "permissions.json"), JSON.stringify([{ match: "npm run *", decision: "allow" }]), "utf8");

    const pm = new PermissionManager(askUser);
    await pm.loadProject(tmp);
    expect(await pm.check("Run npm run build", "medium", false)).toBe(true);
    expect(askCalls).toBe(0);
  });

  it("a project deny rule blocks its match without prompting", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-proj2-"));
    await fs.mkdir(path.join(tmp, ".node-agent"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".node-agent", "permissions.json"), JSON.stringify([{ match: "*rm -rf*", decision: "deny" }]), "utf8");

    const pm = new PermissionManager(askUser);
    await pm.loadProject(tmp);
    expect(await pm.check("Run rm -rf logs", "high", false)).toBe(false);
    expect(askCalls).toBe(0);
  });

  it("falls through to the user when no rule matches", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-proj3-"));
    await fs.mkdir(path.join(tmp, ".node-agent"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".node-agent", "permissions.json"), JSON.stringify([{ match: "git push", decision: "deny" }]), "utf8");

    const pm = new PermissionManager(askUser);
    await pm.loadProject(tmp);
    expect(await pm.check("Run some unrelated edit", "medium", false)).toBe(true); // user says yes
    expect(askCalls).toBe(1);
  });

  it("read-only operations are always allowed without asking", async () => {
    const pm = new PermissionManager(askUser);
    expect(await pm.check("read_file a.ts", "low", true)).toBe(true);
    expect(askCalls).toBe(0);
  });
});