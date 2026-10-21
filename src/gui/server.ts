import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { AgentEvents } from "../agent.js";
import { renderCommand, expandFileReferences } from "../commands.js";
import { runAgentCommand, type CommandResult } from "../agentCommands.js";
import {
  deleteApiProfile,
  listApiProfiles,
  resolveSettings,
  saveApiProfile,
  selectApiProfile,
  setModelOverride,
} from "../llm.js";
import { toUiTranscript, type UiTurn } from "./transcript.js";
import { SseHub } from "./sse.js";
import { GuiRuntime, type PermissionDecision } from "./state.js";
import { resolveProjectDir, type ProjectContext, type SwitchResult } from "./project.js";
import { listRecentProjects } from "./recentProjects.js";
import { backgroundManager } from "../tools/background.js";
import {
  deleteMcpServer,
  loadMcpConfigScoped,
  normalizeMcpConfig,
  saveMcpServer,
  type McpScope,
  type McpServerConfig,
  type McpServerStatus,
} from "../mcp.js";
import type { RuleScope } from "../permissions.js";
import { USAGE_FILE, aggregateUsage, flushUsage, readUsageLog } from "../usage.js";

export interface GuiServerOptions {
  /** Mutable project context; replaced in place when the user switches projects. */
  project: ProjectContext;
  hub: SseHub;
  runtime: GuiRuntime;
  token: string;
  /** Home directory for config/profile storage (tests inject a temp dir). */
  home?: string;
  /** Rebind the backend to another working directory. */
  switchProject?: (cwd: string, opts?: { resumeId?: string }) => Promise<SwitchResult>;
  /** Create a fresh session and point the agent at it (for /clear + "new"). */
  newSession: () => Promise<{ id: string }>;
  /** Resume a stored session into the agent. Returns an error string or null. */
  resumeSession: (id: string) => Promise<string | null>;
  /** List sessions for the sidebar. */
  listSessions: () => Promise<Array<{ id: string; cwd: string; updatedAt: string; model?: string; title?: string; tags?: string[] }>>;
  /** Full-text search over saved sessions (sidebar quick search). */
  searchSessions: (
    q: string,
    o?: { regex?: boolean },
  ) => Promise<
    Array<{
      meta: { id: string; cwd: string; updatedAt: string; model?: string; title?: string; tags?: string[] };
      matches: number;
      snippet: string;
      titleMatch: boolean;
      tagMatch: boolean;
    }>
  >;
  /** Rename a stored session. Returns false when it does not exist. */
  renameSession: (id: string, title: string) => Promise<boolean>;
  /** Replace a stored session's tags. Returns the stored tags or null. */
  tagSession: (id: string, tags: string[]) => Promise<string[] | null>;
  /** Delete a stored session; replaces the agent's session when it was active. */
  deleteSession: (id: string) => Promise<{ ok: boolean; error?: string; activeReplaced?: string }>;
  /** Re-read MCP config and reconnect every server (GUI management). */
  reloadMcp?: () => Promise<McpServerStatus[]>;
  /** True when the backend was started with --no-mcp. */
  mcpDisabled?: boolean;
  /** Usage ledger path override (tests point this at a temp file). */
  usageFile?: string;
  /** Called after /quit or the shutdown button. */
  onQuit: () => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** The page has no inline scripts, so scripts can be locked to same-origin. */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const here = path.dirname(fileURLToPath(import.meta.url));

async function readStatic(name: string): Promise<Buffer> {
  // dist/gui/static after a build, src/gui/static under tsx, plus a fallback
  // for a stale dist checked out next to the sources.
  const candidates = [
    path.join(here, "static", name),
    path.join(here, "..", "..", "src", "gui", "static", name),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p);
    } catch {
      /* try next */
    }
  }
  throw new Error(`gui asset missing: ${name}`);
}

function markedPath(): string {
  const req = createRequire(import.meta.url);
  return req.resolve("marked/marked.min.js");
}

function purifyPath(): string {
  const req = createRequire(import.meta.url);
  return req.resolve("dompurify/purify.min.js");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Drive roots for the directory picker (Windows) or the filesystem root. */
async function listRoots(): Promise<string[]> {
  if (process.platform !== "win32") return [path.parse(process.cwd()).root];
  const roots: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      await fs.access(root);
      roots.push(root);
    } catch {
      /* absent drive */
    }
  }
  return roots;
}

/**
 * Build the request handler. Exported separately from `startGuiServer` so
 * tests can drive it with an injected runtime without opening a socket.
 */
export function createGuiHandler(opts: GuiServerOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const { project, hub, runtime, token } = opts;
  const home = opts.home ?? os.homedir();
  const staticCache = new Map<string, Buffer>();

  async function cachedStatic(name: string): Promise<Buffer> {
    let buf = staticCache.get(name);
    if (!buf) {
      buf = await readStatic(name);
      staticCache.set(name, buf);
    }
    return buf;
  }

  /** The startup token (header or query for SSE) is the gate; the server
   *  binds to 127.0.0.1 and never sets CORS headers. */
  function authorized(req: http.IncomingMessage, url: URL): boolean {
    return req.headers["x-agent-token"] === token || url.searchParams.get("token") === token;
  }

  async function usageSnapshot() {
    await flushUsage();
    const entries = await readUsageLog(opts.usageFile);
    const totals = {
      usd: 0,
      requests: entries.length,
      sessions: new Set(entries.map((e) => e.s).filter(Boolean)).size,
      days: new Set(entries.map((e) => e.t.slice(0, 10))).size,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      unpriced: 0,
    };
    for (const e of entries) {
      totals.usd += e.u ?? 0;
      totals.input += e.i;
      totals.output += e.o;
      totals.cacheRead += e.cr ?? 0;
      totals.cacheWrite += e.cw ?? 0;
      if (!e.p) totals.unpriced += 1;
    }
    const inputSide = totals.input + totals.cacheRead + totals.cacheWrite;
    const titleById = new Map<string, string>();
    try {
      for (const s of await opts.listSessions()) if (s.title) titleById.set(s.id, s.title);
    } catch {
      /* titles are decoration; totals still render */
    }
    const sessionCost = project.agent.costs.snapshot();
    const sessionRequests = Object.values(sessionCost.byModel).reduce((n, m) => n + m.requests, 0);
    return {
      totals: { ...totals, cacheShare: inputSide ? totals.cacheRead / inputSide : 0 },
      byModel: aggregateUsage(entries, "model"),
      byDay: aggregateUsage(entries, "day"),
      bySession: aggregateUsage(entries, "session").map((row) => ({ ...row, title: titleById.get(row.key) ?? null })),
      session: {
        usd: sessionCost.totalUsd,
        requests: sessionRequests,
        budgetUsd: project.agent.costs.budgetUsd,
      },
      ledger: opts.usageFile ?? USAGE_FILE,
    };
  }

  async function mcpSnapshot() {
    const scoped = await loadMcpConfigScoped(project.cwd, home);
    const statusByName = new Map((project.mcp?.statuses ?? []).map((s) => [s.name, s]));
    const projectNames = new Set(Object.keys(scoped.project));
    const servers: Array<{
      name: string;
      scope: McpScope;
      command: string;
      args: string[];
      env: Record<string, string>;
      enabledTools: string[];
      disabledTools: string[];
      disabled: boolean;
      shadowed: boolean;
      status: "connected" | "failed" | "stopped" | "disabled";
      toolCount: number;
      error: string | null;
    }> = [];
    const add = (scope: McpScope, configs: Record<string, McpServerConfig>) => {
      for (const [name, cfg] of Object.entries(configs)) {
        const status = statusByName.get(name);
        servers.push({
          name,
          scope,
          command: cfg.command,
          args: cfg.args ?? [],
          env: cfg.env ?? {},
          enabledTools: cfg.enabledTools ?? [],
          disabledTools: cfg.disabledTools ?? [],
          disabled: !!cfg.disabled,
          shadowed: scope === "global" && projectNames.has(name),
          status: cfg.disabled || opts.mcpDisabled ? "disabled" : status ? (status.connected ? "connected" : "failed") : "stopped",
          toolCount: status?.toolCount ?? 0,
          error: status?.error ?? null,
        });
      }
    };
    add("project", scoped.project);
    add("global", scoped.global);
    servers.sort((a, b) => a.name.localeCompare(b.name) || (a.scope === "project" ? -1 : 1));
    return { servers, disabled: !!opts.mcpDisabled };
  }

  function permissionSnapshot() {
    return {
      mode: project.permissions.mode,
      global: [...(project.permissions.getRules?.() ?? [])],
      project: [...(project.permissions.getProjectRules?.() ?? [])],
    };
  }

  function buildEvents(turn: UiTurn): AgentEvents {
    return {
      onTextDelta: (d) => {
        turn.text += d;
        hub.broadcast("text_delta", { d });
      },
      onToolUseStart: (name, id) => {
        // The model has begun emitting this tool call (args still streaming);
        // show a pending card immediately so the UI never looks frozen.
        if (!turn.tools.some((t) => t.id === id)) turn.tools.push({ id, name, inputPreview: "" });
        hub.broadcast("tool_use_start", { name, id });
      },
      onThinkingDelta: (d) => {
        turn.thinking += d;
        hub.broadcast("thinking_delta", { d });
      },
      onToolStart: (id, name, inputPreview) => {
        const t = turn.tools.find((x) => x.id === id);
        if (t) t.inputPreview = inputPreview;
        else turn.tools.push({ id, name, inputPreview });
        hub.broadcast("tool_start", { id, name, inputPreview });
      },
      onToolEnd: (id, name, ok, preview) => {
        const t = turn.tools.find((x) => x.id === id);
        if (t) {
          t.result = preview;
          t.ok = ok;
        }
        hub.broadcast("tool_end", { id, name, ok, preview });
      },
      onUsage: (input, output) => hub.broadcast("usage", { input, output }),
      onCostWarning: (message) => hub.broadcast("cost_warning", { message }),
      onCompacting: () => hub.broadcast("compacting", {}),
      onCompacted: (before, after) => hub.broadcast("compacted", { before, after }),
      onHook: (event, message) => hub.broadcast("hook", { event, message }),
      onPlanApproved: () => hub.broadcast("plan_approved", {}),
    };
  }

  /**
   * Run a built-in slash command under the command-busy flag. /resume is
   * special-cased: the shared implementation only resets the session, while
   * the GUI must rebind the whole project (cwd, MCP, LSP, permissions).
   */
  async function runCommand(line: string): Promise<CommandResult> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    let sessionChanged = false;
    let sidebarChanged = false;
    const controller = new AbortController();
    runtime.commandBusy = true;
    runtime.commandController = controller;
    hub.broadcast("command_start", { command: cmd });

    let result: CommandResult;
    try {
      if (cmd === "resume") {
        const id = rest[0] ?? "";
        if (!id) {
          result = { kind: "error", text: "usage: /resume <id>" };
        } else {
          const err = await opts.resumeSession(id);
          result = err
            ? { kind: "error", text: `resume failed: ${err}` }
            : { kind: "ok", text: `resumed ${id} (${project.agent.provider}:${project.agent.model})` };
          if (!err) {
            sessionChanged = true;
            sidebarChanged = true;
          }
        }
      } else {
        result = await runAgentCommand(line, {
          agent: project.agent,
          permissions: project.permissions,
          mcp: project.mcp,
          hooks: project.hooks,
          customCommands: project.customCommands,
          cwd: project.agent.cwd,
          notify: (m) => hub.broadcast("system", { text: m }),
          signal: controller.signal,
        });
        if (cmd === "clear" || cmd === "fork") {
          sessionChanged = true;
          sidebarChanged = true;
        } else if (cmd === "rename" || cmd === "tag") {
          sidebarChanged = true;
        }
      }
    } catch (err) {
      result = { kind: "error", text: err instanceof Error ? err.message : String(err) };
    } finally {
      runtime.commandBusy = false;
      runtime.commandController = null;
    }

    hub.broadcast("command_end", {
      command: cmd,
      sessionChanged,
      sidebarChanged,
      text: result.text,
      kind: result.kind,
      highlight: result.highlight,
      quit: !!result.quit,
    });
    return result;
  }

  /** Mirror of the Ink onSubmit dispatch: custom command / slash command / prompt. */
  async function handleChat(text: string, images?: import("../types.js").ImageBlockParam[]): Promise<void> {
    const trimmed = text.trim();
    let promptText = trimmed;
    let display = trimmed;

    if (trimmed.startsWith("/")) {
      const [cmd] = trimmed.slice(1).split(/\s+/);
      const custom = project.customCommands.get(cmd);
      if (custom) {
        const rest = trimmed.slice(1).split(/\s+/).slice(1);
        promptText = renderCommand(custom.template, rest);
        display = `${trimmed}  (/${cmd})`;
      } else {
        // A built-in slash command sent to the chat box: run it as a command.
        const r = await runCommand(trimmed);
        if (r.quit) opts.onQuit();
        return;
      }
    }

    const expanded = await expandFileReferences(promptText, project.agent.cwd);
    if (expanded.files.length) hub.broadcast("system", { text: `@ referenced: ${expanded.files.join(", ")}` });

    const turnId = ++runtime.turnId;
    const turn: UiTurn = { turnId, text: "", thinking: "", tools: [] };
    runtime.busy = true;
    runtime.liveTurn = turn;
    runtime.controller = new AbortController();
    hub.broadcast("turn_start", { turnId, user: display, images: images?.length ?? 0 });

    try {
      const finalText = await project.agent.chat(expanded.text, runtime.controller.signal, buildEvents(turn), images);
      hub.broadcast("turn_end", { turnId, text: finalText });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      hub.broadcast("turn_error", { turnId, message: msg === "aborted" ? "" : msg, aborted: msg === "aborted" });
    } finally {
      runtime.busy = false;
      runtime.liveTurn = null;
      runtime.controller = null;
    }
  }

  function stateSnapshot() {
    const api = resolveSettings({ cwd: project.cwd, home });
    return {
      sessionId: project.agent.sessionId,
      cwd: project.agent.cwd,
      model: project.agent.model,
      provider: project.agent.provider,
      contextWindow: project.agent.contextWindow,
      tokenEstimate: project.agent.tokenEstimate(),
      planMode: project.agent.planMode,
      mode: project.permissions.mode,
      busy: runtime.busy || runtime.commandBusy,
      switching: runtime.switching,
      todos: project.agent.currentTodos(),
      cost: project.agent.costs.format(),
      api: {
        hasKey: !!api.apiKey,
        baseURL: api.baseURL ?? "",
        profile: api.profile ? { id: api.profile.id, name: api.profile.name } : null,
      },
      transcript: toUiTranscript(project.agent.getMessages()),
      liveTurn: runtime.liveTurn,
      pendingPermissions: runtime.pendingPermissions(),
      customCommands: [...project.customCommands.values()].map((c) => ({ name: c.name, description: c.description })),
    };
  }

  /**
   * Clear the session-level /model override and rebuild the backend from the
   * currently selected profile (or legacy config). Used whenever the effective
   * API configuration changes.
   */
  function applyResolvedSettings(): { applied?: { provider: string; model: string }; applyError?: string } {
    setModelOverride(null);
    try {
      const s = resolveSettings({ cwd: project.cwd, home });
      const r = project.agent.switchModel(`${s.provider}:${s.model}`);
      hub.broadcast("settings_changed", { provider: r.provider, model: r.model });
      return { applied: { provider: r.provider, model: r.model } };
    } catch (err) {
      return { applyError: err instanceof Error ? err.message : String(err) };
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const method = req.method ?? "GET";

    // ---- static (no token needed; carries no secrets) ----
    try {
      if (method === "GET" && (p === "/" || p === "/index.html")) {
        res.writeHead(200, { "content-type": MIME[".html"], ...SECURITY_HEADERS });
        res.end(await cachedStatic("index.html"));
        return;
      }
      if (method === "GET" && (p === "/app.js" || p === "/style.css")) {
        const name = p.slice(1);
        res.writeHead(200, { "content-type": MIME[path.extname(name)] ?? "text/plain", "x-content-type-options": "nosniff" });
        res.end(await cachedStatic(name));
        return;
      }
      if (method === "GET" && (p === "/vendor/marked.min.js" || p === "/vendor/purify.min.js")) {
        const file = p.endsWith("purify.min.js") ? purifyPath() : markedPath();
        res.writeHead(200, { "content-type": MIME[".js"], "x-content-type-options": "nosniff" });
        res.end(await fs.readFile(file));
        return;
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`asset error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // ---- everything below is /api/* and requires the token ----
    if (!p.startsWith("/api/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!authorized(req, url)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (method === "GET" && p === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": hello\n\n");
      hub.add(res);
      return;
    }

    if (method === "GET" && p === "/api/state") {
      return sendJson(res, 200, stateSnapshot());
    }

    if (method === "GET" && p === "/api/sessions") {
      return sendJson(res, 200, await opts.listSessions());
    }

    if (method === "GET" && p === "/api/recent-projects") {
      return sendJson(res, 200, await listRecentProjects(home));
    }

    if (method === "GET" && p === "/api/background") {
      const tasks = backgroundManager.list().map((t) => ({
        id: t.id,
        command: t.command,
        startedAt: new Date(t.startedAt).toISOString(),
        running: !t.done,
        exitCode: t.exitCode,
        killed: t.killed,
      }));
      return sendJson(res, 200, { tasks, running: tasks.filter((t) => t.running).length });
    }

    if (method === "GET" && p === "/api/api-profiles") {
      return sendJson(res, 200, listApiProfiles(project.cwd, home));
    }

    if (method === "GET" && p === "/api/fs/dirs") {
      const requested = (url.searchParams.get("path") ?? "").trim() || project.cwd;
      let dir: string;
      try {
        dir = await resolveProjectDir(requested);
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const dirs = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const root = path.parse(dir).root;
        return sendJson(res, 200, {
          path: dir,
          parent: dir === root ? null : path.dirname(dir),
          roots: await listRoots(),
          entries: dirs,
        });
      } catch (err) {
        return sendJson(res, 403, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === "GET" && p === "/api/usage") {
      try {
        return sendJson(res, 200, await usageSnapshot());
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === "GET" && p === "/api/mcp") {
      try {
        return sendJson(res, 200, await mcpSnapshot());
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === "GET" && p === "/api/permissions") {
      return sendJson(res, 200, permissionSnapshot());
    }

    if (method === "GET" && p === "/api/search") {
      const url = new URL(req.url ?? "", "http://localhost");
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return sendJson(res, 400, { error: "missing q" });
      const regex = url.searchParams.get("regex") === "1";
      return sendJson(res, 200, await opts.searchSessions(q, { regex }));
    }

    if (method === "GET" && p === "/api/models") {
      try {
        return sendJson(res, 200, await project.agent.listModels());
      } catch (err) {
        return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === "POST") {
      const body = await readBody(req);

      if (p === "/api/chat") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const text = typeof body.text === "string" ? body.text : "";
        const images = Array.isArray(body.images) ? (body.images as import("../types.js").ImageBlockParam[]) : undefined;
        if (!text.trim() && !images?.length) return sendJson(res, 400, { error: "empty" });
        // Fire and forget: the client watches SSE for turn events.
        void handleChat(text, images);
        return sendJson(res, 202, { ok: true });
      }

      if (p === "/api/abort") {
        runtime.controller?.abort();
        runtime.commandController?.abort();
        runtime.flushPermissions(); // never leave a turn hung on a prompt
        return sendJson(res, 200, { ok: true });
      }

      if (p === "/api/permission") {
        const id = typeof body.id === "string" ? body.id : "";
        const decision = body.decision as PermissionDecision;
        const ok = runtime.respond(id, decision);
        return sendJson(res, ok ? 200 : 404, { ok });
      }

      if (p === "/api/command") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const line = typeof body.line === "string" ? body.line : "";
        const r = await runAgentCommand(line, {
          agent: project.agent,
          permissions: project.permissions,
          mcp: project.mcp,
          hooks: project.hooks,
          customCommands: project.customCommands,
          cwd: project.agent.cwd,
          notify: (m) => hub.broadcast("system", { text: m }),
        });
        if (r.quit) opts.onQuit();
        return sendJson(res, 200, { text: r.text, kind: r.kind, quit: !!r.quit, highlight: r.highlight });
      }

      if (p === "/api/settings") {
        if (typeof body.planMode === "boolean") project.agent.planMode = body.planMode;
        if (body.mode === "default" || body.mode === "auto" || body.mode === "yolo") project.permissions.mode = body.mode;
        return sendJson(res, 200, { ok: true, planMode: project.agent.planMode, mode: project.permissions.mode });
      }

      if (p === "/api/api-profiles") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const provider = body.provider === "openai" ? "openai" : body.provider === "anthropic" ? "anthropic" : null;
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const model = typeof body.model === "string" ? body.model.trim() : "";
        const baseURL = typeof body.baseURL === "string" ? body.baseURL.trim() : "";
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const id = typeof body.id === "string" && body.id ? body.id : undefined;
        if (!provider) return sendJson(res, 400, { error: "provider must be anthropic or openai" });
        if (!name) return sendJson(res, 400, { error: "missing name" });
        if (!model) return sendJson(res, 400, { error: "missing model" });
        if (baseURL && !/^https?:\/\//i.test(baseURL))
          return sendJson(res, 400, { error: "baseURL must start with http:// or https://" });

        let saved: Awaited<ReturnType<typeof saveApiProfile>>;
        try {
          saved = await saveApiProfile(
            { id, name, provider, model, baseURL, ...(apiKey ? { apiKey } : {}) },
            { cwd: project.cwd, home },
          );
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }

        const active = saved.view.activeProfileId === saved.profile.id;
        const applied = active ? applyResolvedSettings() : {};
        if (!active) hub.broadcast("settings_changed", {});
        return sendJson(res, 200, {
          ok: true,
          profile: saved.view.profiles.find((p) => p.id === saved.profile.id) ?? null,
          view: saved.view,
          ...applied,
        });
      }

      if (p === "/api/api-profiles/delete") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return sendJson(res, 400, { error: "missing id" });
        const before = listApiProfiles(project.cwd, home);
        let result: Awaited<ReturnType<typeof deleteApiProfile>>;
        try {
          result = await deleteApiProfile(id, { cwd: project.cwd, home });
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        if (!result.deleted) return sendJson(res, 404, { error: "profile not found" });
        const wasActive = before.activeProfileId === id;
        const applied = wasActive ? applyResolvedSettings() : {};
        if (!wasActive) hub.broadcast("settings_changed", {});
        return sendJson(res, 200, { ok: true, view: result.view, ...applied });
      }

      if (p === "/api/api-profiles/select") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const scope = body.scope === "project" ? "project" : body.scope === "default" ? "default" : null;
        const id = typeof body.id === "string" && body.id ? body.id : null;
        if (!scope) return sendJson(res, 400, { error: "scope must be project or default" });
        let view: Awaited<ReturnType<typeof selectApiProfile>>;
        try {
          view = await selectApiProfile(project.cwd, scope, id, { home });
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        const affectsProject = scope === "project" || !view.projectProfileId;
        const applied = affectsProject ? applyResolvedSettings() : {};
        if (!affectsProject) hub.broadcast("settings_changed", {});
        const active = view.activeProfileId
          ? (view.profiles.find((p) => p.id === view.activeProfileId) ?? null)
          : null;
        return sendJson(res, 200, { ok: true, view, profile: active, ...applied });
      }

      if (p === "/api/background/kill") {
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return sendJson(res, 400, { error: "missing id" });
        if (!backgroundManager.get(id)) return sendJson(res, 404, { error: "task not found" });
        return sendJson(res, 200, { ok: true, killed: backgroundManager.kill(id) });
      }

      if (p === "/api/usage/budget") {
        const usd = body.usd;
        if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0)) {
          return sendJson(res, 400, { error: "usd must be a positive number or null" });
        }
        project.agent.costs.budgetUsd = usd as number | null;
        return sendJson(res, 200, { ok: true, budgetUsd: project.agent.costs.budgetUsd });
      }

      if (p === "/api/mcp/save") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        if (opts.mcpDisabled) return sendJson(res, 400, { error: "MCP is disabled for this run (--no-mcp)" });
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const scope: McpScope | null = body.scope === "project" ? "project" : body.scope === "global" ? "global" : null;
        if (!name) return sendJson(res, 400, { error: "missing name" });
        if (!scope) return sendJson(res, 400, { error: "scope must be global or project" });
        try {
          await saveMcpServer(project.cwd, scope, name, body.config, home);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        let reloadError: string | null = null;
        try {
          await opts.reloadMcp?.();
        } catch (err) {
          reloadError = err instanceof Error ? err.message : String(err);
        }
        return sendJson(res, 200, { ok: true, reloadError, ...(await mcpSnapshot()) });
      }

      if (p === "/api/mcp/delete") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        if (opts.mcpDisabled) return sendJson(res, 400, { error: "MCP is disabled for this run (--no-mcp)" });
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const scope: McpScope | null = body.scope === "project" ? "project" : body.scope === "global" ? "global" : null;
        if (!name) return sendJson(res, 400, { error: "missing name" });
        if (!scope) return sendJson(res, 400, { error: "scope must be global or project" });
        let deleted: boolean;
        try {
          deleted = await deleteMcpServer(project.cwd, scope, name, home);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        if (!deleted) return sendJson(res, 404, { error: "server not found in that scope" });
        let reloadError: string | null = null;
        try {
          await opts.reloadMcp?.();
        } catch (err) {
          reloadError = err instanceof Error ? err.message : String(err);
        }
        return sendJson(res, 200, { ok: true, reloadError, ...(await mcpSnapshot()) });
      }

      if (p === "/api/mcp/reload") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        if (opts.mcpDisabled) return sendJson(res, 400, { error: "MCP is disabled for this run (--no-mcp)" });
        if (!opts.reloadMcp) return sendJson(res, 501, { error: "not supported" });
        let reloadError: string | null = null;
        try {
          await opts.reloadMcp();
        } catch (err) {
          reloadError = err instanceof Error ? err.message : String(err);
        }
        return sendJson(res, 200, { ok: true, reloadError, ...(await mcpSnapshot()) });
      }

      if (p === "/api/permissions/add") {
        const scope: RuleScope | null = body.scope === "project" ? "project" : body.scope === "global" ? "global" : null;
        const match = typeof body.match === "string" ? body.match : "";
        const decision = body.decision === "allow" || body.decision === "deny" ? body.decision : null;
        if (!scope) return sendJson(res, 400, { error: "scope must be global or project" });
        if (!decision) return sendJson(res, 400, { error: "decision must be allow or deny" });
        try {
          await project.permissions.addRule(scope, match, decision);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return sendJson(res, 200, { ok: true, ...permissionSnapshot() });
      }

      if (p === "/api/permissions/delete") {
        const scope: RuleScope | null = body.scope === "project" ? "project" : body.scope === "global" ? "global" : null;
        const index = typeof body.index === "number" ? body.index : Number.NaN;
        if (!scope) return sendJson(res, 400, { error: "scope must be global or project" });
        if (!Number.isInteger(index)) return sendJson(res, 400, { error: "missing rule index" });
        let removed;
        try {
          removed = await project.permissions.removeRule(scope, index);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        if (!removed) return sendJson(res, 404, { error: "rule not found" });
        return sendJson(res, 200, { ok: true, ...permissionSnapshot() });
      }

      if (p === "/api/project") {
        const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
        if (!cwd) return sendJson(res, 400, { error: "missing cwd" });
        if (!opts.switchProject) return sendJson(res, 501, { error: "not supported" });
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const r = await opts.switchProject(cwd);
        return sendJson(res, r.ok ? 200 : r.error === "busy" ? 409 : 400, r);
      }

      if (p === "/api/resume") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const id = typeof body.id === "string" ? body.id : "";
        const err = await opts.resumeSession(id);
        return sendJson(res, err ? 404 : 200, err ? { error: err } : { ok: true });
      }

      if (p === "/api/new") {
        if (runtime.busy || runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const s = await opts.newSession();
        return sendJson(res, 200, { ok: true, sessionId: s.id });
      }

      if (p === "/api/session/rename") {
        const id = typeof body.id === "string" ? body.id : "";
        const title = typeof body.title === "string" ? body.title : "";
        const ok = await opts.renameSession(id, title);
        return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "session not found" });
      }

      if (p === "/api/session/tags") {
        const id = typeof body.id === "string" ? body.id : "";
        const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];
        const saved = await opts.tagSession(id, tags);
        return sendJson(res, saved ? 200 : 404, saved ? { ok: true, tags: saved } : { error: "session not found" });
      }

      if (p === "/api/session/delete") {
        if (runtime.commandBusy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const id = typeof body.id === "string" ? body.id : "";
        const r = await opts.deleteSession(id);
        return sendJson(res, r.ok ? 200 : 404, r);
      }

      if (p === "/api/shutdown") {
        sendJson(res, 200, { ok: true });
        setTimeout(() => opts.onQuit(), 50);
        return;
      }
    }

    res.writeHead(404);
    res.end();
  };
}

export interface RunningGui {
  url: string;
  token: string;
  port: number;
  close: () => Promise<void>;
}

/** Bind to 127.0.0.1 and return the URL (with token fragment) to open. */
export async function startGuiServer(opts: GuiServerOptions, port = 0): Promise<RunningGui> {
  const handler = createGuiHandler(opts);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    token: opts.token,
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/#${opts.token}`,
    close: () =>
      new Promise<void>((resolve) => {
        opts.hub.closeAll();
        server.close(() => resolve());
      }),
  };
}
