import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpManager } from "../src/mcp.js";
import { getTool } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

const AUTH = "Bearer test-token";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Minimal stateful streamable-HTTP MCP server exposing one zero-arg tool. */
function startMcpServer(): { server: Server; url: () => string } {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }
    if (req.method === "POST" && isInitializeRequest(body)) {
      let transport!: StreamableHTTPServerTransport;
      const mcp = new McpServer({ name: "remote-test", version: "1.0.0" });
      mcp.registerTool("echo", { description: "Return pong" }, async () => ({
        content: [{ type: "text" as const, text: "pong" }],
      }));
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "bad request" }, id: null }));
  });
  return {
    server,
    url: () => {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}/mcp`;
    },
  };
}

const toolCtx: ToolContext = { cwd: process.cwd(), askPermission: async () => true };

describe("remote MCP over streamable HTTP", () => {
  let fixture: ReturnType<typeof startMcpServer>;
  let manager: McpManager;

  beforeAll(async () => {
    fixture = startMcpServer();
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await manager?.shutdown();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  it("connects, registers tools, and calls them with configured headers", async () => {
    manager = new McpManager();
    const statuses = await manager.connectAll({
      remote: { url: fixture.url(), headers: { Authorization: AUTH } },
    });
    expect(statuses).toEqual([{ name: "remote", connected: true, toolCount: 1, kind: "http" }]);

    const tool = getTool("mcp__remote__echo");
    expect(tool).toBeDefined();
    const result = await tool!.execute({}, toolCtx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("pong");
  });

  it("reports a failed connection without throwing", async () => {
    const bad = new McpManager();
    const status = await bad.connect("bad", { url: fixture.url(), headers: { Authorization: "Bearer wrong" } });
    expect(status.connected).toBe(false);
    expect(status.error).toMatch(/remote MCP connection failed/);
    expect(status.error).toMatch(/http:/);
    await bad.shutdown();
  });
});
