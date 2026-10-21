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
  /** Kept in the config file but not connected (GUI toggle). */
  disabled?: boolean;
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
export async function loadMcpConfig(cwd: string, home: string = os.homedir()): Promise<Record<string, McpServerConfig>> {
  const scoped = await loadMcpConfigScoped(cwd, home);
  const out: Record<string, McpServerConfig> = {};
  for (const configs of [scoped.global, scoped.project]) {
    for (const [name, cfg] of Object.entries(configs)) {
      if (!cfg.disabled) out[name] = cfg;
    }
  }
  return out;
}

export interface ScopedMcpConfigs {
  global: Record<string, McpServerConfig>;
  project: Record<string, McpServerConfig>;
}

export type McpScope = "global" | "project";

export function mcpConfigPath(scope: McpScope, cwd: string, home: string = os.homedir()): string {
  return scope === "project" ? path.join(cwd, ".mcp.json") : path.join(home, ".node-agent", "mcp.json");
}

/** Both config layers unmerged, so the management UI can show where a server lives. */
export async function loadMcpConfigScoped(cwd: string, home: string = os.homedir()): Promise<ScopedMcpConfigs> {
  return {
    global: await readMcpFile(mcpConfigPath("global", cwd, home)),
    project: await readMcpFile(mcpConfigPath("project", cwd, home)),
  };
}

/** Tolerant read used for connecting; corrupt files are treated as empty. */
async function readMcpFile(file: string): Promise<Record<string, McpServerConfig>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
  const servers = isRecord(parsed) ? (isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed) : {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (isRecord(cfg) && typeof cfg.command === "string") out[name] = cfg as unknown as McpServerConfig;
  }
  return out;
}

/** Read a config file for mutation; unlike connect-time reads, bad JSON must not be overwritten. */
async function readMcpFileForWrite(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${file} exists but is not valid JSON — fix it before saving MCP settings`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

/** Validate and normalize a GUI-supplied server config. */
export function normalizeMcpConfig(input: unknown): McpServerConfig {
  if (!isRecord(input)) throw new Error("invalid server config");
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("command is required");
  const cfg: McpServerConfig = { command };
  const args = optionalStringArray(input.args, "args");
  if (args?.length) cfg.args = args;
  const enabledTools = optionalStringArray(input.enabledTools, "enabledTools");
  if (enabledTools?.length) cfg.enabledTools = enabledTools;
  const disabledTools = optionalStringArray(input.disabledTools, "disabledTools");
  if (disabledTools?.length) cfg.disabledTools = disabledTools;
  if (input.env !== undefined && input.env !== null) {
    if (!isRecord(input.env)) throw new Error("env must be an object");
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(input.env)) {
      if (!key || typeof val !== "string") throw new Error("env values must be strings");
      env[key] = val;
    }
    if (Object.keys(env).length) cfg.env = env;
  }
  if (input.disabled === true) cfg.disabled = true;
  return cfg;
}

async function writeMcpFile(file: string, root: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
}

export async function saveMcpServer(
  cwd: string,
  scope: McpScope,
  name: string,
  config: unknown,
  home: string = os.homedir(),
): Promise<void> {
  const cleanName = name.trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(cleanName)) {
    throw new Error("server name must be 1-40 characters: letters, digits, dot, underscore or dash");
  }
  const cfg = normalizeMcpConfig(config);
  const file = mcpConfigPath(scope, cwd, home);
  const parsed = await readMcpFileForWrite(file);
  if (!parsed) {
    await writeMcpFile(file, { mcpServers: { [cleanName]: cfg } });
    return;
  }
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  servers[cleanName] = cfg;
  await writeMcpFile(file, parsed);
}

export async function deleteMcpServer(
  cwd: string,
  scope: McpScope,
  name: string,
  home: string = os.homedir(),
): Promise<boolean> {
  const file = mcpConfigPath(scope, cwd, home);
  const parsed = await readMcpFileForWrite(file);
  if (!parsed) return false;
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  if (!(name in servers)) return false;
  delete servers[name];
  await writeMcpFile(file, parsed);
  return true;
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
