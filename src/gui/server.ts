import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Agent } from "../agent.js";
import type { AgentEvents } from "../agent.js";
import type { PermissionManager } from "../permissions.js";
import type { SlashCommand } from "../commands.js";
import { renderCommand, expandFileReferences } from "../commands.js";
import { runAgentCommand } from "../agentCommands.js";
import { toUiTranscript, type UiTurn } from "./transcript.js";
import { SseHub } from "./sse.js";
import { GuiRuntime, type PermissionDecision } from "./state.js";

export interface GuiServerOptions {
  agent: Agent;
  permissions: PermissionManager;
  hub: SseHub;
  runtime: GuiRuntime;
  customCommands: Map<string, SlashCommand>;
  token: string;
  /** Slash-command context (mcp/hooks live here). */
  commandCtx: {
    mcp: import("../mcp.js").McpManager | null;
    hooks: import("../hooks.js").HookManager;
  };
  /** Create a fresh session and point the agent at it (for /clear + "new"). */
  newSession: () => Promise<{ id: string }>;
  /** Resume a stored session into the agent. Returns an error string or null. */
  resumeSession: (id: string) => Promise<string | null>;
  /** List sessions for the sidebar. */
  listSessions: () => Promise<Array<{ id: string; cwd: string; updatedAt: string; model?: string; title?: string }>>;
  /** Full-text search over saved sessions (sidebar quick search). */
  searchSessions: (
    q: string,
    o?: { regex?: boolean },
  ) => Promise<
    Array<{
      meta: { id: string; cwd: string; updatedAt: string; model?: string; title?: string };
      matches: number;
      snippet: string;
      titleMatch: boolean;
    }>
  >;
  /** Rename a stored session. Returns false when it does not exist. */
  renameSession: (id: string, title: string) => Promise<boolean>;
  /** Delete a stored session; replaces the agent's session when it was active. */
  deleteSession: (id: string) => Promise<{ ok: boolean; error?: string; activeReplaced?: string }>;
  /** Called after /quit or the shutdown button. */
  onQuit: () => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
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

/**
 * Build the request handler. Exported separately from `startGuiServer` so
 * tests can drive it with an injected runtime without opening a socket.
 */
export function createGuiHandler(opts: GuiServerOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const { agent, permissions, hub, runtime, customCommands, token } = opts;
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

  /** Mirror of the Ink onSubmit dispatch: custom command / slash command / prompt. */
  async function handleChat(text: string, images?: import("../types.js").ImageBlockParam[]): Promise<void> {
    const trimmed = text.trim();
    let promptText = trimmed;
    let display = trimmed;

    if (trimmed.startsWith("/")) {
      const [cmd] = trimmed.slice(1).split(/\s+/);
      const custom = customCommands.get(cmd);
      if (custom) {
        const rest = trimmed.slice(1).split(/\s+/).slice(1);
        promptText = renderCommand(custom.template, rest);
        display = `${trimmed}  (/${cmd})`;
      } else {
        // A built-in slash command sent to the chat box: run it as a command.
        const r = await runAgentCommand(trimmed, {
          agent,
          permissions,
          mcp: opts.commandCtx.mcp,
          hooks: opts.commandCtx.hooks,
          customCommands,
          cwd: agent.cwd,
          notify: (m) => hub.broadcast("system", { text: m }),
        });
        if (r.quit) opts.onQuit();
        if (r.text) hub.broadcast("system", { text: r.text, kind: r.kind, highlight: r.highlight });
        return;
      }
    }

    const expanded = await expandFileReferences(promptText, agent.cwd);
    if (expanded.files.length) hub.broadcast("system", { text: `@ referenced: ${expanded.files.join(", ")}` });

    const turnId = ++runtime.turnId;
    const turn: UiTurn = { turnId, text: "", thinking: "", tools: [] };
    runtime.busy = true;
    runtime.liveTurn = turn;
    runtime.controller = new AbortController();
    hub.broadcast("turn_start", { turnId, user: display, images: images?.length ?? 0 });

    try {
      const finalText = await agent.chat(expanded.text, runtime.controller.signal, buildEvents(turn), images);
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
    return {
      sessionId: agent.sessionId,
      cwd: agent.cwd,
      model: agent.model,
      provider: agent.provider,
      contextWindow: agent.contextWindow,
      tokenEstimate: agent.tokenEstimate(),
      planMode: agent.planMode,
      mode: permissions.mode,
      busy: runtime.busy,
      todos: agent.currentTodos(),
      cost: agent.costs.format(),
      transcript: toUiTranscript(agent.getMessages()),
      liveTurn: runtime.liveTurn,
      pendingPermissions: runtime.pendingPermissions(),
      customCommands: [...customCommands.values()].map((c) => ({ name: c.name, description: c.description })),
    };
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const method = req.method ?? "GET";

    // ---- static (no token needed; carries no secrets) ----
    try {
      if (method === "GET" && (p === "/" || p === "/index.html")) {
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(await cachedStatic("index.html"));
        return;
      }
      if (method === "GET" && (p === "/app.js" || p === "/style.css")) {
        const name = p.slice(1);
        res.writeHead(200, { "content-type": MIME[path.extname(name)] ?? "text/plain" });
        res.end(await cachedStatic(name));
        return;
      }
      if (method === "GET" && p === "/vendor/marked.min.js") {
        res.writeHead(200, { "content-type": MIME[".js"] });
        res.end(await fs.readFile(markedPath()));
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

    if (method === "GET" && p === "/api/search") {
      const url = new URL(req.url ?? "", "http://localhost");
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return sendJson(res, 400, { error: "missing q" });
      const regex = url.searchParams.get("regex") === "1";
      return sendJson(res, 200, await opts.searchSessions(q, { regex }));
    }

    if (method === "GET" && p === "/api/models") {
      try {
        return sendJson(res, 200, await agent.listModels());
      } catch (err) {
        return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === "POST") {
      const body = await readBody(req);

      if (p === "/api/chat") {
        if (runtime.busy) return sendJson(res, 409, { error: "busy" });
        const text = typeof body.text === "string" ? body.text : "";
        const images = Array.isArray(body.images) ? (body.images as import("../types.js").ImageBlockParam[]) : undefined;
        if (!text.trim() && !images?.length) return sendJson(res, 400, { error: "empty" });
        // Fire and forget: the client watches SSE for turn events.
        void handleChat(text, images);
        return sendJson(res, 202, { ok: true });
      }

      if (p === "/api/abort") {
        runtime.controller?.abort();
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
        const line = typeof body.line === "string" ? body.line : "";
        const r = await runAgentCommand(line, {
          agent,
          permissions,
          mcp: opts.commandCtx.mcp,
          hooks: opts.commandCtx.hooks,
          customCommands,
          cwd: agent.cwd,
          notify: (m) => hub.broadcast("system", { text: m }),
        });
        if (r.quit) opts.onQuit();
        return sendJson(res, 200, { text: r.text, kind: r.kind, quit: !!r.quit, highlight: r.highlight });
      }

      if (p === "/api/settings") {
        if (typeof body.planMode === "boolean") agent.planMode = body.planMode;
        if (body.mode === "default" || body.mode === "auto" || body.mode === "yolo") permissions.mode = body.mode;
        return sendJson(res, 200, { ok: true, planMode: agent.planMode, mode: permissions.mode });
      }

      if (p === "/api/resume") {
        const id = typeof body.id === "string" ? body.id : "";
        const err = await opts.resumeSession(id);
        return sendJson(res, err ? 404 : 200, err ? { error: err } : { ok: true });
      }

      if (p === "/api/new") {
        const s = await opts.newSession();
        return sendJson(res, 200, { ok: true, sessionId: s.id });
      }

      if (p === "/api/session/rename") {
        const id = typeof body.id === "string" ? body.id : "";
        const title = typeof body.title === "string" ? body.title : "";
        const ok = await opts.renameSession(id, title);
        return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "session not found" });
      }

      if (p === "/api/session/delete") {
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
