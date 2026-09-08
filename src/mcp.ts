import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { registerTool, unregisterToolsByPrefix } from "./tools/index.js";
import { truncate as truncateToolOutput } from "./tools/utils.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Restrict which tools are exposed: allowlist of remote tool names. */
  enabledTools?: string[];
  disabledTools?: string[];
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  prefix: string;
}

const NAMESPACE = "mcp__";

/** Sanitize a name so it is a valid Anthropic tool name ([a-zA-Z0-9_-]{1,64}). */
function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

/** Load server configs from ~/.node-agent/mcp.json and <cwd>/.mcp.json (project wins). */
export async function loadMcpConfig(cwd: string): Promise<Record<string, McpServerConfig>> {
  const merge = async (file: string, into: Record<string, McpServerConfig>) => {
    try {
      const raw = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      const servers = raw.mcpServers ?? raw; // accept {mcpServers:{...}} or flat {...}
      for (const [name, cfg] of Object.entries(servers)) {
        if (cfg && typeof (cfg as McpServerConfig).command === "string") into[name] = cfg as McpServerConfig;
      }
    } catch {
      /* file optional */
    }
  };
  const out: Record<string, McpServerConfig> = {};
  await merge(path.join(os.homedir(), ".node-agent", "mcp.json"), out);
  await merge(path.join(cwd, ".mcp.json"), out);
  return out;
}

function flattenContent(content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>): string {
  if (!content?.length) return "(no content)";
  return content
    .map((c) => {
      if (c.type === "text") return c.text ?? "";
      if (c.type === "image") return `[image ${c.mimeType ?? ""} ${c.data ? `${c.data.length}b64 chars` : ""}]`;
      if (c.type === "resource") return `[resource] ${JSON.stringify(c).slice(0, 500)}`;
      return JSON.stringify(c).slice(0, 500);
    })
    .join("\n");
}

/** Wrap one remote MCP tool as a local Tool. */
function wrapTool(server: ConnectedServer, remote: { name: string; description?: string; inputSchema?: unknown }): Tool {
  const localName = `${server.prefix}${safe(remote.name)}`;
  return {
    name: localName,
    description:
      `[MCP:${server.name}] ` + (remote.description || "No description provided by the MCP server."),
    isReadOnly: false, // MCP servers can do anything; treat as needing permission
    inputSchema: (remote.inputSchema as Tool["inputSchema"]) ?? { type: "object", properties: {} },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const ok = await ctx.askPermission(
        `Call MCP tool ${server.name}/${remote.name} with ${JSON.stringify(input).slice(0, 120)}`,
        "medium",
      );
      if (!ok) return { content: "The user rejected this MCP tool call.", isError: true };
      try {
        const res = await server.client.callTool({ name: remote.name, arguments: input }, undefined, {
          signal: ctx.signal,
          timeout: 60_000,
        });
        const text = flattenContent((res.content ?? []) as never);
        return {
          content: truncateToolOutput(text) || "(empty result)",
          isError: !!res.isError,
        };
      } catch (err) {
        return { content: `MCP call failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  statuses: McpServerStatus[] = [];

  async connectAll(configs: Record<string, McpServerConfig>): Promise<McpServerStatus[]> {
    this.statuses = [];
    for (const [name, cfg] of Object.entries(configs)) {
      this.statuses.push(await this.connect(name, cfg));
    }
    return this.statuses;
  }

  async connect(name: string, cfg: McpServerConfig): Promise<McpServerStatus> {
    const prefix = `${NAMESPACE}${safe(name)}__`;
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
        cwd: process.cwd(),
        stderr: "pipe",
      });
      const client = new Client({ name: "node-agent", version: "0.1.0" });
      await client.connect(transport);

      const { tools: remoteTools } = await client.listTools();
      const filtered = remoteTools.filter((t) => {
        if (cfg.enabledTools?.length) return cfg.enabledTools.includes(t.name);
        if (cfg.disabledTools?.length) return !cfg.disabledTools.includes(t.name);
        return true;
      });

      let registered = 0;
      for (const rt of filtered) {
        if (registerTool(wrapTool({ name, client, transport, prefix }, rt))) registered++;
      }

      this.servers.set(name, { name, client, transport, prefix });
      const status: McpServerStatus = { name, connected: true, toolCount: registered };
      this.statuses = this.statuses.filter((s) => s.name !== name).concat(status);
      return status;
    } catch (err) {
      const status: McpServerStatus = {
        name,
        connected: false,
        toolCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
      this.statuses = this.statuses.filter((s) => s.name !== name).concat(status);
      return status;
    }
  }

  async disconnect(name: string) {
    const server = this.servers.get(name);
    if (!server) return;
    unregisterToolsByPrefix(server.prefix);
    await server.client.close().catch(() => {});
    this.servers.delete(name);
    this.statuses = this.statuses.filter((s) => s.name !== name);
  }

  async shutdown() {
    for (const name of [...this.servers.keys()]) await this.disconnect(name);
  }
}
