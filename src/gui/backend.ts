import { randomBytes } from "node:crypto";
import { Agent } from "../agent.js";
import { PermissionManager } from "../permissions.js";
import { HookManager } from "../hooks.js";
import { McpManager, loadMcpConfig } from "../mcp.js";
import { loadSlashCommands, type SlashCommand } from "../commands.js";
import { configureLsp, disposeLsp, loadLspConfig } from "../lsp.js";
import { createSession, loadSession, listSessions, renameSession, deleteSession, searchSessions, tagSession, type SessionMeta } from "../session.js";
import type { MessageParam } from "../types.js";
import { SseHub } from "./sse.js";
import { GuiRuntime } from "./state.js";
import { startGuiServer, type RunningGui } from "./server.js";

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

/**
 * Assemble the full agent stack (session, MCP, LSP, hooks, permissions) and
 * start the GUI HTTP backend. Shared by `agent --gui` (browser mode) and the
 * Electron main process, so the two frontends cannot drift apart.
 */
export async function startGuiBackend(opts: GuiStartOptions): Promise<RunningBackend> {
  // ---- session ----
  let sessionId: string;
  let initialMessages: MessageParam[] | undefined;
  let initialModel: string | undefined;
  let cwd = opts.cwd;
  if (opts.resume) {
    const loaded = await loadSession(opts.resume);
    if (!loaded) throw new Error(`Session "${opts.resume}" not found.`);
    cwd = loaded.meta.cwd;
    process.chdir(cwd);
    sessionId = loaded.meta.id;
    initialMessages = loaded.messages.length ? loaded.messages : undefined;
    initialModel = loaded.meta.model;
  } else {
    const s = await createSession(cwd);
    sessionId = s.id;
  }

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
  const hub = new SseHub();
  const runtime = new GuiRuntime(hub);
  const permissions = new PermissionManager((desc, risk, preview) => runtime.askPermission(desc, risk, preview));
  await permissions.load();
  await permissions.loadProject(cwd);
  if (opts.yolo) permissions.mode = "yolo";
  else if (opts.auto) permissions.mode = "auto";

  // ---- hooks + custom commands ----
  const hooks = new HookManager();
  await hooks.load(cwd);
  const customCommands: Map<string, SlashCommand> = await loadSlashCommands(cwd);

  // ---- agent ----
  const agent = new Agent(cwd, sessionId, permissions, initialMessages, initialModel, hooks);
  await agent.startSession(initialMessages ? "resume" : "startup");
  if (opts.plan) agent.planMode = true;
  runtime.attach(agent, permissions);
  // A stuck permission prompt with no client to answer it would hang the turn
  // forever; when the last tab/window closes, deny outstanding prompts.
  hub.onEmpty = () => runtime.flushPermissions();

  const token = randomBytes(16).toString("hex");

  const gui = await startGuiServer(
    {
      agent,
      permissions,
      hub,
      runtime,
      customCommands,
      token,
      commandCtx: { mcp, hooks },
      newSession: async () => {
        const s = await createSession(cwd);
        await agent.resetSession(s.id);
        return s;
      },
      resumeSession: async (id) => {
        const loaded = await loadSession(id);
        if (!loaded) return "session not found";
        await agent.resetSession(loaded.meta.id, loaded.messages, loaded.meta.model);
        if (loaded.meta.model) {
          try {
            agent.switchModel(loaded.meta.model);
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
        const active = id === agent.sessionId;
        if (active && runtime.busy) return { ok: false, error: "busy" };
        const ok = await deleteSession(id);
        if (!ok) return { ok: false, error: "session not found" };
        if (active) {
          const s = await createSession(cwd);
          await agent.resetSession(s.id);
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
    await mcp?.shutdown();
    await disposeLsp();
  };

  return { gui, shutdown };
}
