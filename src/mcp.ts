import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { registerTool, unregisterToolsByPrefix } from "./tools/index.js";
import { boundedResult } from "./artifacts.js";
import { McpOAuthFlow } from "./mcpAuth.js";
import { atomicWriteFile } from "./atomicWrite.js";

/**
 * An MCP server exposing more than this many tools has them marked deferred:
 * they leave the model's tool list and are discovered via tool_search, so a
 * 40-tool server costs one search tool instead of 40 schemas per request.
 */
export const MCP_DEFER_TOOLS = 12;

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Remote endpoint; mutually exclusive with `command`. */
  url?: string;
  /** Extra HTTP headers for remote servers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Remote transport; unset = try streamable HTTP, then fall back to SSE. */
  type?: "http" | "sse";
  /** Use OAuth 2.1 (authorization code + PKCE) for a remote server. */
  oauth?: boolean;
  /** Restrict which tools are exposed: allowlist of remote tool names. */
  enabledTools?: string[];  disabledTools?: string[];
  /** Kept in the config file but not connected (GUI toggle). */
  disabled?: boolean;
}

export type McpTransportKind = "stdio" | "http" | "sse";

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  /** How the server is reached; absent when the connection failed before a transport was chosen. */
  kind?: McpTransportKind;
  error?: string;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: Transport;
  prefix: string;
}

const NAMESPACE = "mcp__";
const REMOTE_CONNECT_TIMEOUT_MS = 15_000;
const LIST_TOOLS_TIMEOUT_MS = 15_000;
const MAX_LISTED_TOOLS = 1000;

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

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
    if (name === "__proto__") continue;
    if (isRecord(cfg) && (typeof cfg.command === "string" || typeof cfg.url === "string")) {
      out[name] = cfg as unknown as McpServerConfig;
    }
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

function optionalHeaders(input: unknown): Record<string, string> | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input)) throw new Error("headers must be an object");
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(input)) {
    if (!key || typeof val !== "string") throw new Error("header values must be strings");
    headers[key] = val;
  }
  return Object.keys(headers).length ? headers : undefined;
}

/** Validate and normalize a GUI-supplied server config. */
export function normalizeMcpConfig(input: unknown): McpServerConfig {
  if (!isRecord(input)) throw new Error("invalid server config");
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (command && url) throw new Error("use either command (stdio) or url (remote), not both");
  if (!command && !url) throw new Error("command or url is required");
  if (input.oauth !== undefined && input.oauth !== null && input.oauth !== false && input.oauth !== true) {
    throw new Error("oauth must be a boolean");
  }
  const useOauth = input.oauth === true;
  if (useOauth && !url) throw new Error("oauth is only valid for remote servers");

  let cfg: McpServerConfig;
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("url must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("url must start with http:// or https://");
    }
    if (useOauth && parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
      throw new Error("oauth requires https (plain http is only allowed for localhost)");
    }
    cfg = { url };
    if (input.type !== undefined && input.type !== null && input.type !== "") {
      if (input.type !== "http" && input.type !== "sse") throw new Error('type must be "http" or "sse"');
      cfg.type = input.type;
    }
    const headers = optionalHeaders(input.headers);
    if (headers) cfg.headers = headers;
    if (useOauth) cfg.oauth = true;
  } else {
    cfg = { command };
    const args = optionalStringArray(input.args, "args");
    if (args?.length) cfg.args = args;
    if (input.env !== undefined && input.env !== null) {
      if (!isRecord(input.env)) throw new Error("env must be an object");
      const env: Record<string, string> = {};
      for (const [key, val] of Object.entries(input.env)) {
        if (!key || typeof val !== "string") throw new Error("env values must be strings");
        env[key] = val;
      }
      if (Object.keys(env).length) cfg.env = env;
    }
  }

  const enabledTools = optionalStringArray(input.enabledTools, "enabledTools");
  if (enabledTools?.length) cfg.enabledTools = enabledTools;
  const disabledTools = optionalStringArray(input.disabledTools, "disabledTools");
  if (disabledTools?.length) cfg.disabledTools = disabledTools;
  if (input.disabled === true) cfg.disabled = true;
  return cfg;
}

async function writeMcpFile(file: string, root: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteFile(file, `${JSON.stringify(root, null, 2)}\n`, 0o600);
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
  if (cleanName === "__proto__") throw new Error("server name is reserved");
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

interface RemoteToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Wrap one remote MCP tool as a local Tool. */
function wrapTool(server: ConnectedServer, remote: RemoteToolDef, deferred: boolean): Tool {
  const localName = `${server.prefix}${safe(remote.name)}`;
  return {
    name: localName,
    description:
      `[MCP:${server.name}] ` + (remote.description || "No description provided by the MCP server."),
    isReadOnly: false, // MCP servers can do anything; treat as needing permission
    deferred,
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
          content: (await boundedResult(text, 30_000, "mcp-result")) || "(empty result)",
          isError: !!res.isError,
        };
      } catch (err) {
        return { content: `MCP call failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}

interface ConnectResult {
  client: Client;
  transport: Transport;
  kind: McpTransportKind;
}

/** Collect every page of tools/list; a repeated cursor cannot loop forever. */
async function listAllTools(client: Client): Promise<RemoteToolDef[]> {
  const timeout = envMs("AGENT_MCP_LIST_TIMEOUT_MS", LIST_TOOLS_TIMEOUT_MS);
  const tools: RemoteToolDef[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined, { timeout });
    for (const t of res.tools) {
      tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      if (tools.length >= MAX_LISTED_TOOLS) return tools;
    }
    cursor = res.nextCursor;
    if (!cursor) return tools;
    if (seen.has(cursor)) throw new Error("MCP server repeated a tools/list cursor");
    seen.add(cursor);
  }
  return tools;
}

async function connectStdio(cfg: McpServerConfig, name: string): Promise<ConnectResult> {
  const transport = new StdioClientTransport({
    command: cfg.command!,
    args: cfg.args ?? [],
    env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
    cwd: process.cwd(),
    stderr: "pipe",
  });
  // The SDK pipes stderr into a PassThrough. It must be consumed or a chatty
  // server eventually blocks on a full pipe; keep a tail for diagnostics.
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });
  const client = new Client({ name: "node-agent", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    const tail = stderrTail.trim().split("\n").slice(-5).join(" · ");
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw new Error(`stdio MCP server "${name}" failed: ${describeError(err)}${tail ? ` — stderr: ${tail}` : ""}`);
  }
  return { client, transport, kind: "stdio" };
}

/**
 * Remote endpoints: try the streamable HTTP transport first and fall back to
 * the legacy SSE transport, mirroring the MCP spec's migration guidance. An
 * explicit `type` skips the fallback so a misconfiguration fails fast.
 *
 * With `oauth: true` the SDK drives discovery/registration/PKCE through the
 * flow's provider; a 401 opens the authorization URL, and once the loopback
 * callback delivers a code the same transport kind is retried with the
 * stored tokens. Later connections reuse the saved tokens (and refresh them).
 */
async function connectRemote(cfg: McpServerConfig, name: string, opts: McpManagerOptions): Promise<ConnectResult> {
  const url = new URL(cfg.url!);
  let flow: McpOAuthFlow | null = null;
  try {
    if (cfg.oauth) {
      const envTimeout = Number(process.env.AGENT_MCP_OAUTH_TIMEOUT_MS);
      flow = await McpOAuthFlow.start({
        serverName: name,
        serverUrl: cfg.url!,
        authDir: opts.authDir,
        timeoutMs: opts.oauthTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined),
        openUrl: opts.openUrl,
        log: opts.log,
      });
    }
    const kinds: Array<"http" | "sse"> =
      cfg.type === "http" ? ["http"] : cfg.type === "sse" ? ["sse"] : ["http", "sse"];
    const transportOptions = {
      ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
      ...(flow ? { authProvider: flow.provider } : {}),
    };
    const make = (kind: "http" | "sse") =>
      kind === "http"
        ? new StreamableHTTPClientTransport(url, transportOptions)
        : new SSEClientTransport(url, transportOptions);

    const failures: string[] = [];
    let authorized = false;
    for (const kind of kinds) {
      const first = await attemptConnect(make(kind));
      if (first.ok) return { client: first.client, transport: first.transport, kind };
      if (flow && !authorized && first.error instanceof UnauthorizedError) {
        authorized = true;
        try {
          const code = await flow.waitForCode();
          await first.transport.finishAuth(code);
        } catch (err) {
          await closeAttempt(first);
          failures.push(`${kind}: ${describeError(err)}`);
          break; // another transport cannot succeed before the user authorizes
        }
        await closeAttempt(first);
        const retry = await attemptConnect(make(kind));
        if (retry.ok) return { client: retry.client, transport: retry.transport, kind };
        failures.push(`${kind}: ${describeError(retry.error)}`);
        await closeAttempt(retry);
        continue;
      }
      failures.push(`${kind}: ${describeError(first.error)}`);
      await closeAttempt(first);
    }
    throw new Error(`remote MCP connection failed (${failures.join("; ")})`);
  } finally {
    await flow?.close();
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type AttemptResult =
  | { ok: true; client: Client; transport: StreamableHTTPClientTransport | SSEClientTransport }
  | { ok: false; error: unknown; client: Client; transport: StreamableHTTPClientTransport | SSEClientTransport };

async function attemptConnect(transport: StreamableHTTPClientTransport | SSEClientTransport): Promise<AttemptResult> {
  const client = new Client({ name: "node-agent", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: REMOTE_CONNECT_TIMEOUT_MS });
    return { ok: true, client, transport };
  } catch (error) {
    return { ok: false, error, client, transport };
  }
}

async function closeAttempt(attempt: AttemptResult): Promise<void> {
  await attempt.client.close().catch(() => {});
  await attempt.transport.close().catch(() => {});
}

export interface McpManagerOptions {
  /** Browser launcher for OAuth redirects (tests inject their own). */
  openUrl?: (url: string) => void;
  /** How long to wait for the OAuth callback. */
  oauthTimeoutMs?: number;
  /** Token store directory (defaults to ~/.node-agent/mcp-auth). */
  authDir?: string;
  log?: (message: string) => void;
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  statuses: McpServerStatus[] = [];

  constructor(private readonly opts: McpManagerOptions = {}) {}

  async connectAll(configs: Record<string, McpServerConfig>): Promise<McpServerStatus[]> {
    this.statuses = [];
    for (const [name, cfg] of Object.entries(configs)) {
      this.statuses.push(await this.connect(name, cfg));
    }
    return this.statuses;
  }

  async connect(name: string, cfg: McpServerConfig): Promise<McpServerStatus> {
    const prefix = `${NAMESPACE}${safe(name)}__`;
    let client: Client | null = null;
    let transport: Transport | null = null;
    try {
      if (cfg.url && cfg.command) throw new Error("config has both command and url — keep only one");
      const conn = cfg.url ? await connectRemote(cfg, name, this.opts) : await connectStdio(cfg, name);
      client = conn.client;
      transport = conn.transport;

      const remoteTools = await listAllTools(client);
      const filtered = remoteTools.filter((t) => {
        if (cfg.enabledTools?.length) return cfg.enabledTools.includes(t.name);
        if (cfg.disabledTools?.length) return !cfg.disabledTools.includes(t.name);
        return true;
      });

      let registered = 0;
      // A server with many tools would dominate every request's tool list;
      // its tools become deferred and are discovered via tool_search instead.
      const defer = filtered.length > MCP_DEFER_TOOLS;
      for (const rt of filtered) {
        if (registerTool(wrapTool({ name, client, transport, prefix }, rt, defer))) registered++;
      }

      this.servers.set(name, { name, client, transport, prefix });
      const status: McpServerStatus = { name, connected: true, toolCount: registered, kind: conn.kind };
      this.statuses = this.statuses.filter((s) => s.name !== name).concat(status);
      return status;
    } catch (err) {
      await client?.close().catch(() => {});
      await transport?.close().catch(() => {});
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
