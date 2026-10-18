import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { AgentEvents } from "../agent.js";
import { renderCommand, expandFileReferences } from "../commands.js";
import { runAgentCommand } from "../agentCommands.js";
import { toUiTranscript, clipInput, clipText, RESULT_CLIP, type UiItem, type UiSubCall, type UiTurn } from "./transcript.js";
import { backgroundManager } from "../tools/background.js";
import { appendSubCall } from "../session.js";
import type { ProfileInput, PublicProfile } from "../llmProfiles.js";
import { SseHub } from "./sse.js";
import { GuiRuntime, type PermissionDecision } from "./state.js";
import type { ProjectContext, SwitchResult } from "./project.js";

export interface GuiServerOptions {
  /** Mutable project context; replaced in place when the user switches projects. */
  project: ProjectContext;
  hub: SseHub;
  runtime: GuiRuntime;
  token: string;
  /** Rebind the backend to another working directory. */
  switchProject?: (cwd: string, opts?: { resumeId?: string }) => Promise<SwitchResult>;
  /** Create a fresh session and point the agent at it (for /clear + "new"). */
  newSession: () => Promise<{ id: string }>;
  /** Resume a stored session into the agent. Returns an error string or null. */
  resumeSession: (id: string) => Promise<string | null>;
  /** List sessions for the sidebar. */
  listSessions: () => Promise<
    Array<{ id: string; cwd: string; updatedAt: string; model?: string; title?: string; tags?: string[]; preview?: string }>
  >;
  /** Full-text search over saved sessions (sidebar quick search). */
  searchSessions: (
    q: string,
    o?: { regex?: boolean },
  ) => Promise<
    Array<{
      meta: { id: string; cwd: string; updatedAt: string; model?: string; title?: string; tags?: string[]; preview?: string };
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
  /** Delete a stored session; when it was the active one the agent drops back to "no session". */
  deleteSession: (id: string) => Promise<{ ok: boolean; error?: string; activeCleared?: boolean }>;
  /** LLM profiles behind the 模型配置 panel; keys are never sent in the clear. */
  listLlmProfiles?: () => Promise<{ activeId?: string; profiles: PublicProfile[]; projectOverrides: boolean }>;
  saveLlmProfile?: (input: ProfileInput) => Promise<{ ok: boolean; id?: string; error?: string }>;
  deleteLlmProfile?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** Switch the whole runtime to a saved profile (persists + rebuilds the client). */
  activateLlmProfile?: (id: string) => Promise<{ ok: boolean; provider?: string; model?: string; error?: string; warning?: string }>;
  /** Turn a profile off: clears the active marker and the values it persists. */
  disableLlmProfile?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** Model ids served by a draft (unsaved) config, for the 「拉取列表」 button. */
  listModelsForProfile?: (input: ProfileInput) => Promise<{ models?: string[]; note?: string; error?: string }>;
  /** Fire-and-forget: re-read the model's context window from the endpoint. */
  refreshModelMeta?: () => void;
  /** Called after /quit or the shutdown button. */
  onQuit: () => void;
}

/** Re-attach in-memory subagent chains to the cards rebuilt from history. */
function attachSubCalls(items: UiItem[], chains: Map<string, UiSubCall[]>): UiItem[] {
  for (const item of items) {
    if (item.kind !== "tool" || !item.tool) continue;
    const calls = chains.get(item.tool.id);
    if (calls?.length) item.tool.subCalls = calls;
  }
  return items;
}

/** Validate the body of an LLM-profile request. `model` is required to save a
 *  profile, but optional when only listing an endpoint's models. */
function parseProfileInput(body: Record<string, unknown>, requireModel: boolean): ProfileInput | null {
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (requireModel && !model) return null;
  const provider = body.provider === "openai" ? "openai" : "anthropic";
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  const out: ProfileInput = { name: rawName || model, provider, model };
  if (typeof body.id === "string" && body.id.trim()) out.id = body.id.trim();
  if (typeof body.baseURL === "string" && body.baseURL.trim()) out.baseURL = body.baseURL.trim();
  if (typeof body.apiKey === "string" && body.apiKey.trim()) out.apiKey = body.apiKey.trim();
  const rawCtx = body.contextWindow;
  const ctx = typeof rawCtx === "number" ? rawCtx : typeof rawCtx === "string" ? Number(rawCtx) : NaN;
  if (Number.isFinite(ctx) && ctx > 0) out.contextWindow = Math.floor(ctx);
  return out;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
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
  // marked 18+ ships only the ESM entry plus a UMD bundle (no marked.min.js).
  // Serve the UMD build so a plain <script> tag still gets a `marked` global.
  const pkgDir = path.dirname(req.resolve("marked/package.json"));
  return path.join(pkgDir, "lib", "marked.umd.js");
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
  const { project, hub, runtime, token } = opts;
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
        const seg = turn.rounds?.[turn.rounds.length - 1];
        if (seg) seg.text += d;
        hub.broadcast("text_delta", { d });
      },
      onRoundStart: (round) => {
        turn.round = round;
        (turn.rounds ??= []).push({ round, text: "", thinking: "" });
        hub.broadcast("round_start", { round });
      },
      onToolUseStart: (name, id) => {
        // The model has begun emitting this tool call (args still streaming);
        // show a pending card immediately so the UI never looks frozen.
        if (!turn.tools.some((t) => t.id === id)) {
          turn.tools.push({ id, name, round: turn.round ?? 1, inputPreview: "" });
        }
        hub.broadcast("tool_use_start", { name, id, round: turn.round ?? 1 });
      },
      onThinkingDelta: (d) => {
        turn.thinking += d;
        const seg = turn.rounds?.[turn.rounds.length - 1];
        if (seg) seg.thinking += d;
        hub.broadcast("thinking_delta", { d });
      },
      onToolStart: (id, name, inputPreview, input) => {
        const clipped = input ? clipInput(input) : undefined;
        const t = turn.tools.find((x) => x.id === id);
        if (t) {
          t.inputPreview = inputPreview;
          if (clipped) t.input = clipped;
        } else {
          turn.tools.push({ id, name, round: turn.round ?? 1, inputPreview, input: clipped });
        }
        hub.broadcast("tool_start", { id, name, inputPreview, input: clipped });
      },
      onToolEnd: (id, name, ok, preview, result) => {
        const full = result === undefined ? preview : clipText(result, RESULT_CLIP);
        const t = turn.tools.find((x) => x.id === id);
        if (t) {
          t.result = full;
          t.ok = ok;
        }
        hub.broadcast("tool_end", { id, name, ok, preview, result: full });
      },
      onSubTool: (parentId, name, inputPreview, ok, preview, round) => {
        // Keep the chain out-of-band as well: the live turn is dropped at
        // turn_end, but the card is rebuilt from history right after.
        const call: UiSubCall = { name, inputPreview, ok, result: preview };
        if (round) call.round = round;
        runtime.recordSubCall(parentId, call);
        // Persist it (UI-only line) so a restart or /resume keeps the chain.
        const sessionId = project.agent.sessionId;
        if (sessionId) void appendSubCall(sessionId, { toolUseId: parentId, ...call }).catch(() => {});
        const t = turn.tools.find((x) => x.id === parentId);
        if (t) (t.subCalls ??= []).push(call);
        hub.broadcast("sub_tool", { id: parentId, name, inputPreview, ok, preview, round });
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
      const custom = project.customCommands.get(cmd);
      if (custom) {
        const rest = trimmed.slice(1).split(/\s+/).slice(1);
        promptText = renderCommand(custom.template, rest);
        display = `${trimmed}  (/${cmd})`;
      } else {
        // A built-in slash command sent to the chat box: run it as a command.
        const r = await runAgentCommand(trimmed, {
          agent: project.agent,
          permissions: project.permissions,
          mcp: project.mcp,
          hooks: project.hooks,
          customCommands: project.customCommands,
          cwd: project.agent.cwd,
          notify: (m) => hub.broadcast("system", { text: m }),
        });
        if (r.quit) opts.onQuit();
        if (r.text) hub.broadcast("system", { text: r.text, kind: r.kind, highlight: r.highlight });
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
    return {
      sessionId: project.agent.sessionId,
      cwd: project.agent.cwd,
      model: project.agent.model,
      provider: project.agent.provider,
      contextWindow: project.agent.contextWindow,
      tokenEstimate: project.agent.tokenEstimate(),
      planMode: project.agent.planMode,
      mode: project.permissions.mode,
      busy: runtime.busy,
      switching: runtime.switching,
      todos: project.agent.currentTodos(),
      cost: project.agent.costs.format(),
      /** Still-running background shells (shown in the composer toolbar). */
      backgroundTasks: backgroundManager.list().filter((t) => !t.done).length,
      transcript: attachSubCalls(toUiTranscript(project.agent.getMessages()), runtime.subCalls),
      liveTurn: runtime.liveTurn,
      pendingPermissions: runtime.pendingPermissions(),
      customCommands: [...project.customCommands.values()].map((c) => ({ name: c.name, description: c.description })),
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
      if (method === "GET" && (p === "/icon.png" || p === "/favicon.ico")) {
        const name = p === "/favicon.ico" ? "icon.ico" : "icon.png";
        res.writeHead(200, { "content-type": MIME[path.extname(name)] });
        res.end(await cachedStatic(name));
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
        return sendJson(res, 200, await project.agent.listModels());
      } catch (err) {
        return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === "GET" && p === "/api/llm/profiles") {
      if (!opts.listLlmProfiles) return sendJson(res, 501, { error: "not supported" });
      return sendJson(res, 200, await opts.listLlmProfiles());
    }

    if (method === "POST") {
      const body = await readBody(req);

      if (p === "/api/chat") {
        if (runtime.busy || runtime.switching) return sendJson(res, 409, { error: "busy" });
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
          agent: project.agent,
          permissions: project.permissions,
          mcp: project.mcp,
          hooks: project.hooks,
          customCommands: project.customCommands,
          cwd: project.agent.cwd,
          notify: (m) => hub.broadcast("system", { text: m }),
        });
        if (r.quit) opts.onQuit();
        // A model switch may change the context window.
        if (/^\/model\b/.test(line.trim())) opts.refreshModelMeta?.();
        return sendJson(res, 200, { text: r.text, kind: r.kind, quit: !!r.quit, highlight: r.highlight });
      }

      if (p === "/api/settings") {
        if (typeof body.planMode === "boolean") project.agent.planMode = body.planMode;
        if (body.mode === "default" || body.mode === "auto" || body.mode === "yolo") project.permissions.mode = body.mode;
        return sendJson(res, 200, { ok: true, planMode: project.agent.planMode, mode: project.permissions.mode });
      }

      if (p === "/api/llm/profile/save") {
        if (!opts.saveLlmProfile) return sendJson(res, 501, { error: "not supported" });
        const input = parseProfileInput(body, true);
        if (!input) return sendJson(res, 400, { error: "name and model are required" });
        const r = await opts.saveLlmProfile(input);
        return sendJson(res, r.ok ? 200 : 400, r);
      }

      if (p === "/api/llm/profile/delete") {
        if (!opts.deleteLlmProfile) return sendJson(res, 501, { error: "not supported" });
        const r = await opts.deleteLlmProfile(typeof body.id === "string" ? body.id : "");
        return sendJson(res, r.ok ? 200 : 404, r);
      }

      if (p === "/api/llm/profile/activate") {
        if (!opts.activateLlmProfile) return sendJson(res, 501, { error: "not supported" });
        const r = await opts.activateLlmProfile(typeof body.id === "string" ? body.id : "");
        const status = r.ok ? 200 : r.error === "busy" ? 409 : r.error === "not found" ? 404 : 400;
        return sendJson(res, status, r);
      }

      if (p === "/api/llm/profile/disable") {
        if (!opts.disableLlmProfile) return sendJson(res, 501, { error: "not supported" });
        const r = await opts.disableLlmProfile(typeof body.id === "string" ? body.id : "");
        return sendJson(res, r.ok ? 200 : 404, r);
      }

      if (p === "/api/llm/models") {
        if (!opts.listModelsForProfile) return sendJson(res, 501, { error: "not supported" });
        const input = parseProfileInput(body, false);
        if (!input) return sendJson(res, 400, { error: "provider is required" });
        const r = await opts.listModelsForProfile(input);
        return sendJson(res, r.models ? 200 : 502, r);
      }

      if (p === "/api/project") {
        const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
        if (!cwd) return sendJson(res, 400, { error: "missing cwd" });
        if (!opts.switchProject) return sendJson(res, 501, { error: "not supported" });
        if (runtime.busy || runtime.switching) return sendJson(res, 409, { error: "busy" });
        const r = await opts.switchProject(cwd);
        return sendJson(res, r.ok ? 200 : r.error === "busy" ? 409 : 400, r);
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

      if (p === "/api/session/tags") {
        const id = typeof body.id === "string" ? body.id : "";
        const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];
        const saved = await opts.tagSession(id, tags);
        return sendJson(res, saved ? 200 : 404, saved ? { ok: true, tags: saved } : { error: "session not found" });
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
