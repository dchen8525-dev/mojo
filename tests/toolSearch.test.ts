import { afterEach, describe, expect, it } from "vitest";
import { registerTool, unregisterToolsByPrefix, deferredTools, exposeTool, isExposed } from "../src/tools/index.js";
import { toolSearchTool } from "../src/tools/toolSearch.js";

const ctx = {} as never;

function addDeferred(name: string, description: string) {
  registerTool({
    name,
    description,
    isReadOnly: true,
    deferred: true,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: "ran" };
    },
  });
}

afterEach(() => {
  unregisterToolsByPrefix("ts_def_");
});

describe("tool_search", () => {
  it("reports when nothing is hidden", async () => {
    const r = await toolSearchTool.execute({ query: "anything" }, ctx);
    expect(r.content).toContain("No deferred tools");
  });

  it("exposes keyword matches and they leave the hidden set", async () => {
    addDeferred("ts_def_alpha", "deploy sites and manage releases");
    addDeferred("ts_def_beta", "totally unrelated storage quota");
    const r = await toolSearchTool.execute({ query: "deploy release" }, ctx);
    expect(r.content).toContain("ts_def_alpha");
    expect(r.content).not.toContain("ts_def_beta");
    expect(isExposed("ts_def_alpha")).toBe(true);
    expect(isExposed("ts_def_beta")).toBe(false);
    expect(deferredTools().map((t) => t.name)).toEqual(["ts_def_beta"]);
  });

  it("select: exposes exact names and reports misses", async () => {
    addDeferred("ts_def_gamma", "some tool");
    const r = await toolSearchTool.execute({ query: "select:ts_def_gamma, nope" }, ctx);
    expect(r.content).toContain("Exposed: ts_def_gamma");
    expect(r.content).toContain("Not found");
    expect(isExposed("ts_def_gamma")).toBe(true);
  });

  it("suggests broader terms when nothing matches", async () => {
    addDeferred("ts_def_delta", "database migrations");
    const r = await toolSearchTool.execute({ query: "zzz-never-matches" }, ctx);
    expect(r.content).toContain("No hidden tool matches");
    expect(isExposed("ts_def_delta")).toBe(false);
  });

  it("exposeTool refuses non-deferred tools", () => {
    expect(exposeTool("read_file")).toBe(false);
  });

  it("unregistering a server drops its exposure state", async () => {
    addDeferred("ts_def_eps", "ephemeral tool");
    expect(exposeTool("ts_def_eps")).toBe(true);
    unregisterToolsByPrefix("ts_def_");
    expect(isExposed("ts_def_eps")).toBe(false);
  });
});
