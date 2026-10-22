import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpManager } from "../src/mcp.js";
import { getTool, unregisterToolsByPrefix } from "../src/tools/index.js";

/**
 * Minimal newline-delimited JSON-RPC MCP server. The SDK transport speaks this
 * framing, so a fake server needs no dependency on the SDK itself.
 */
function serverScript(listHandler: string, prefix = ""): string {
  return `${prefix}
let buffer = "";
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send(msg.id, {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      });
    } else if (msg.method === "tools/list") {
      ${listHandler}
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;
}

const ONE_TOOL = `
send(msg.id, {
  tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }],
});
`;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-stdio-"));
});

afterEach(async () => {
  unregisterToolsByPrefix("mcp__paged__");
  unregisterToolsByPrefix("mcp__noisy__");
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeServer(name: string, script: string): Promise<string> {
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, script, "utf8");
  return file;
}

describe("stdio MCP connections", () => {
  it("follows tools/list pagination instead of stopping at the first page", async () => {
    const script = await writeServer(
      "paged",
      serverScript(`
        const page = msg.params && msg.params.cursor ? Number(msg.params.cursor) : 0;
        const tools = Array.from({ length: 5 }, (_, j) => ({
          name: "tool" + (page * 5 + j),
          description: "t",
          inputSchema: { type: "object", properties: {} },
        }));
        send(msg.id, { tools, ...(page < 2 ? { nextCursor: String(page + 1) } : {}) });
      `),
    );
    const manager = new McpManager();
    try {
      const status = await manager.connect("paged", { command: process.execPath, args: [script] });
      expect(status).toMatchObject({ name: "paged", connected: true, toolCount: 15, kind: "stdio" });
      expect(getTool("mcp__paged__tool14")).toBeTruthy();
      expect(getTool("mcp__paged__tool0")?.deferred).toBe(true);
    } finally {
      await manager.shutdown();
    }
  });

  it("drains chatty stderr instead of blocking the server", async () => {
    const script = await writeServer(
      "noisy",
      serverScript(ONE_TOOL, 'process.stderr.write("noisy ".repeat(60_000));\n'),
    );
    const manager = new McpManager();
    try {
      const status = await manager.connect("noisy", { command: process.execPath, args: [script] });
      expect(status).toMatchObject({ connected: true, toolCount: 1 });
    } finally {
      await manager.shutdown();
    }
  });

  it("includes the stderr tail when the server dies during startup", async () => {
    const script = await writeServer(
      "broken",
      'process.stderr.write("missing API token XYZ\\n");\nsetTimeout(() => process.exit(3), 50);\n',
    );
    const status = await new McpManager().connect("broken", { command: process.execPath, args: [script] });
    expect(status.connected).toBe(false);
    expect(status.error).toContain('stdio MCP server "broken" failed');
    expect(status.error).toContain("missing API token XYZ");
  });

  it("bounds a tools/list request that never answers", async () => {
    const script = await writeServer("silent", serverScript("// never respond"));
    const previous = process.env.AGENT_MCP_LIST_TIMEOUT_MS;
    process.env.AGENT_MCP_LIST_TIMEOUT_MS = "200";
    const manager = new McpManager();
    const started = Date.now();
    try {
      const status = await manager.connect("silent", { command: process.execPath, args: [script] });
      expect(status.connected).toBe(false);
      expect(status.error).toMatch(/timed? ?out/i);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await manager.shutdown();
      if (previous === undefined) delete process.env.AGENT_MCP_LIST_TIMEOUT_MS;
      else process.env.AGENT_MCP_LIST_TIMEOUT_MS = previous;
    }
  }, 15_000);
});
