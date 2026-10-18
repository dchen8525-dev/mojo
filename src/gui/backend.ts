import { randomBytes } from "node:crypto";
import { Agent } from "../agent.js";
import { PermissionManager, type Mode } from "../permissions.js";
import { HookManager } from "../hooks.js";
import { McpManager, loadMcpConfig } from "../mcp.js";
import { loadSlashCommands, type SlashCommand } from "../commands.js";
import { configureLsp, disposeLsp, loadLspConfig } from "../lsp.js";
import { backgroundManager } from "../tools/background.js";
import { setModelOverride } from "../llm.js";
import { createSession, loadSession, listSessions, renameSession, deleteSession, searchSessions, tagSession, type SessionMeta } from "../session.js";
import type { MessageParam } from "../types.js";
import { SseHub } from "./sse.js";
import { GuiRuntime } from "./state.js";
import { startGuiServer, type RunningGui } from "./server.js";
import { resolveProjectDir, samePath, type ProjectContext, type SwitchResult } from "./project.js";

export interface GuiStartOptions {
  /** Working directory (the project the agent operates on). */
  cwd: string;
  /** Session id to resume; a new one is created when absent. */
  resume?: string;
  auto?: boolean;
  yolo?: boolean;
  plan?: boolean;
  noMcp?: boolean;
  noLsp?: boolean;
  /** 0 picks an ephemeral port (what Electron uses). */
  port?: number;
  /** Called when the UI asks to quit (button / /quit / window close). */
  onQuit: () => void;
}

export interface RunningBackend {
  gui: RunningGui;
  /** Tear down MCP/LSP/server. Idempotent. */
  shutdown: () => Promise<void>;
}

interface SessionSeed {
  id: string;
  messages?: MessageParam[];
  model?: string;
}

interface BuildOptions {
  session: SessionSeed;
  mode: Mode;
  noMcp: boolean;
  noLsp: boolean;
  askPermission: PermissionManager["askUser"];
}

/** Load (or create) the session a project context will start with. */
async function seedSession(cwd: string, resumeId?: string): Promise<SessionSeed> {
  if (resumeId) {
    const loaded = await loadSession(resumeId);
    if (!loaded) throw new Error(`Session "${resumeId}" not found.`);
    return {
      id: loaded.meta.id,
      messages: loaded.messages.length ? loaded.messages : undefined,
      model: loaded.meta.model,
    };
  }
  const created = await createSession(cwd);
  return { id: created.id };
}

/**
 * Assemble everything scoped to one working directory. Called once at startup
 * and again for every /api/project switch; the old context's processes must be
 * torn down by the caller first.
 */
async function buildProject(cwd: string, opts: BuildOptions): Promise<ProjectContext> {
  // ---- MCP ----
  let mcp: McpManager | null = null;
  if (!opts.noMcp) {
    const configs = await loadMcpConfig(cwd);
    if (Object.keys(configs).length) {
      mcp = new McpManager();
      const statuses = await mcp.connectAll(configs);
      for (const s of statuses) {
        if (s.connected) console.error(`mcp: ${s.name} connected (${s.toolCount} tools)`);
        else console.error(`mcp: ${s.name} failed: ${s.error}`);
      }
    }
  }

  // ---- LSP ----
  if (opts.noLsp) configureLsp(cwd, { enabled: false });
  else configureLsp(cwd, { enabled: true, servers: await loadLspConfig(cwd) });

  // ---- permissions (the GUI modal answers via the SSE/POST round-trip) ----
  const permissions = new PermissionManager(opts.askPermission);
  permissions.mode = opts.mode;
  await permissions.load();
  await permissions.loadProject(cwd);

  // ---- hooks + custom commands ----
  const hooks = new HookManager();
  await hooks.load(cwd);
  const customCommands: Map<string, SlashCommand> = await loadSlashCommands(cwd);

  // ---- agent ----
  const { session } = opts;
  const agent = new Agent(cwd, session.id, permissions, session.messages, session.model, hooks);
  if (session.model) {
    try {
      agent.switchModel(session.model);
    } catch {
      /* no key for that provider - keep the model resolved from config/env */
    }
  }
  await agent.startSession(session.messages?.length ? "resume" : "startup");

  return { cwd, agent, permissions, hooks, customCommands, mcp };
}

/**
 * Assemble the full agent stack (session, MCP, LSP, hooks, permissions) and
 * start the GUI HTTP backend. Shared by `agent --gui` (browser mode) and the
 * Electron main process, so the two frontends cannot drift apart.
 */
export async function startGuiBackend(opts: GuiStartOptions): Promise<RunningBackend> {
  // ---- session ----
  let cwd = opts.cwd;
  let resumeId: string | undefined;
  if (opts.resume) {
    const loaded = await loadSession(opts.resume);
    if (!loaded) throw new Error(`Session "${opts.resume}" not found.`);
    cwd = loaded.meta.cwd;
    resumeId = loaded.meta.id;
  }
  cwd = await resolveProjectDir(cwd);
  process.chdir(cwd);

  const hub = new SseHub();
  const runtime = new GuiRuntime(hub);
  const mode: Mode = opts.yolo ? "yolo" : opts.auto ? "auto" : "default";
  const noMcp = !!opts.noMcp;
  const noLsp = !!opts.noLsp;

  const session = await seedSession(cwd, resumeId);
  const project = await buildProject(cwd, {
    session,
    mode,
    noMcp,
    noLsp,
    askPermission: (desc, risk, preview) => runtime.askPermission(desc, risk, preview),
  });
  runtime.attach(project.agent, project.permissions);
  // A stuck permission prompt with no client to answer it would hang the turn
  // forever; when the last tab/window closes, deny outstanding prompts.
  hub.onEmpty = () => runtime.flushPermissions();

  const token = randomBytes(16).toString("hex");

  /**
   * Switch the whole runtime to another working directory. The old project's
   * MCP servers, language server and background shell tasks are torn down; the
   * new project's permissions/hooks/commands/LSP/MCP are loaded before the
   * context is swapped in.
   */
  async function switchProject(input: string, o: { resumeId?: string } = {}): Promise<SwitchResult> {
    if (runtime.busy || runtime.switching) return { ok: false, error: "busy" };

    let target: string;
    try {
      target = await resolveProjectDir(input);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!o.resumeId && samePath(target, project.cwd)) {
      return { ok: true, cwd: project.cwd, sessionId: project.agent.sessionId };
    }

    runtime.switching = true;
    try {
      // Prepare the target session before tearing anything down, so a missing
      // session file or an unwritable directory leaves the old project intact.
      const nextSession = await seedSession(target, o.resumeId);

      try {
        await project.mcp?.shutdown();
      } catch {
        /* best effort - the process may already be gone */
      }
      try {
        await disposeLsp();
      } catch {
        /* best effort */
      }
      backgroundManager.killAll();

      try {
        process.chdir(target);
      } catch {
        /* valid directory; chdir can still fail on exotic mounts */
      }

      // A /model override belongs to the previous session; the new project's
      // selected profile (or its config) must win on switch.
      setModelOverride(null);
      const next = await buildProject(target, {
        session: nextSession,
        mode: project.permissions.mode,
        noMcp,
        noLsp,
        askPermission: (desc, risk, preview) => runtime.askPermission(desc, risk, preview),
      });
      // Keep the same object identity: the HTTP handler holds this reference.
      Object.assign(project, next);
      runtime.attach(project.agent, project.permissions);
      hub.broadcast("project_changed", {
        cwd: project.cwd,
        sessionId: project.agent.sessionId,
        model: project.agent.model,
        provider: project.agent.provider,
      });
      return { ok: true, cwd: project.cwd, sessionId: project.agent.sessionId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      runtime.switching = false;
    }
  }

  const gui = await startGuiServer(
    {
      project,
      hub,
      runtime,
      token,
      switchProject,
      newSession: async () => {
        const s = await createSession(project.cwd);
        await project.agent.resetSession(s.id);
        return s;
      },
      resumeSession: async (id) => {
        const loaded = await loadSession(id);
        if (!loaded) return "session not found";
        let target: string;
        try {
          target = await resolveProjectDir(loaded.meta.cwd);
        } catch (err) {
          return `session working directory is unavailable: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (!samePath(target, project.cwd)) {
          const r = await switchProject(target, { resumeId: id });
          return r.ok ? null : r.error;
        }
        await project.agent.resetSession(loaded.meta.id, loaded.messages, loaded.meta.model);
        if (loaded.meta.model) {
          try {
            project.agent.switchModel(loaded.meta.model);
          } catch {
            /* no key for that provider - keep current model */
          }
        }
        return null;
      },
      listSessions: async (): Promise<SessionMeta[]> => listSessions(),
      searchSessions: async (q, o) => searchSessions(q, { regex: o?.regex, limit: 20 }),
      renameSession: async (id, title) => renameSession(id, title),
      tagSession: async (id, tags) => tagSession(id, tags),
      deleteSession: async (id) => {
        // Deleting the session the agent is currently writing to would leave
        // dangling appends; swap in a fresh one first.
        const active = id === project.agent.sessionId;
        if (active && runtime.busy) return { ok: false, error: "busy" };
        const ok = await deleteSession(id);
        if (!ok) return { ok: false, error: "session not found" };
        if (active) {
          const s = await createSession(project.cwd);
          await project.agent.resetSession(s.id);
          return { ok: true, activeReplaced: s.id };
        }
        return { ok: true };
      },
      onQuit: opts.onQuit,
    },
    opts.port ?? 0,
  );

  let shut = false;
  const shutdown = async () => {
    if (shut) return;
    shut = true;
    runtime.controller?.abort();
    runtime.flushPermissions();
    await gui.close();
    await project.mcp?.shutdown();
    await disposeLsp();
  };

  return { gui, shutdown };
}
