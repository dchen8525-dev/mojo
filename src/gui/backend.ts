import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Agent } from "../agent.js";
import { LLM, type Config } from "../llm.js";
import { mergeConfigJson, readConfigJson } from "../configFile.js";
import {
  deleteProfile,
  findProfile,
  loadProfileStore,
  publicProfile,
  saveProfileStore,
  upsertProfile,
  type ProfileInput,
  type PublicProfile,
} from "../llmProfiles.js";
import { PermissionManager, type Mode } from "../permissions.js";
import { HookManager } from "../hooks.js";
import { McpManager, loadMcpConfig, untrustedProjectMcp, type McpServerStatus } from "../mcp.js";
import { loadSlashCommands, type SlashCommand } from "../commands.js";
import { configureLsp, disposeLsp, loadLspConfig } from "../lsp.js";
import { backgroundManager } from "../tools/background.js";
import { CronScheduler } from "../cronScheduler.js";
import {
  loadSession,
  listSessions,
  renameSession,
  deleteSession,
  searchSessions,
  tagSession,
  type SessionMeta,
  type SessionSubCall,
} from "../session.js";
import type { MessageParam } from "../types.js";
import { SseHub } from "./sse.js";
import { GuiRuntime } from "./state.js";
import { startGuiServer, type RunningGui } from "./server.js";
import { resolveProjectDir, samePath, type ProjectContext, type SwitchResult } from "./project.js";
import { rememberRecentProject } from "./recentProjects.js";

/** Where each SDK looks for the model list when no baseURL is configured. */
const DEFAULT_BASE_URL = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1" } as const;

/** The URL `listModels` will hit, for error messages. */
function modelsUrl(provider: "anthropic" | "openai", baseURL?: string): string {
  const base = (baseURL?.trim() || DEFAULT_BASE_URL[provider]).replace(/\/+$/, "");
  return provider === "openai" ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Last resort for Anthropic-format gateways: ask the same host's OpenAI-style
 * `/models` with bearer auth. DeepSeek, for one, serves the Anthropic wire
 * format at `/anthropic` but only exposes the model list at `/models`.
 * Returns null when that is unavailable too.
 */
async function listOpenAiModels(baseURL: string | undefined, apiKey: string): Promise<string[] | null> {
  let origin: string;
  try {
    origin = new URL(baseURL?.trim() || DEFAULT_BASE_URL.anthropic).origin;
  } catch {
    return null;
  }
  try {
    const res = await fetch(`${origin}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: string } | string> };
    const ids = (body.data ?? []).map((m) => (typeof m === "string" ? m : m.id)).filter((id): id is string => !!id);
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

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
  /** Don't run the scheduled-task scheduler in this process (--no-cron). */
  noCron?: boolean;
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
  /** UI-only subagent chains stored in the session file. */
  subCalls?: SessionSubCall[];
  todos?: SessionMeta["todos"];
}

interface BuildOptions {
  session: SessionSeed;
  mode: Mode;
  plan: boolean;
  noMcp: boolean;
  noLsp: boolean;
  askPermission: PermissionManager["askUser"];
}

/** Load the session a project context resumes, or start with none at all. */
async function seedSession(cwd: string, resumeId?: string): Promise<SessionSeed> {
  if (resumeId) {
    const loaded = await loadSession(resumeId);
    if (!loaded) throw new Error(`Session "${resumeId}" not found.`);
    return {
      id: loaded.meta.id,
      messages: loaded.messages.length ? loaded.messages : undefined,
      model: loaded.meta.model,
      subCalls: loaded.subCalls,
      todos: loaded.meta.todos,
    };
  }
  // No session file up front: `Agent.chat` creates one on the first message,
  // so merely opening the app does not add an empty row to the sidebar.
  return { id: "" };
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
    const untrustedMcp = await untrustedProjectMcp(cwd);
    if (untrustedMcp) console.error(`mcp: project config not loaded (untrusted): ${untrustedMcp.file} — approve it in Manage → MCP`);
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
  const untrustedHooks = hooks.untrustedProjectHooks();
  if (untrustedHooks) console.error(`hooks: project hooks not loaded (untrusted): ${untrustedHooks.file} — run /hooks trust`);
  const customCommands: Map<string, SlashCommand> = await loadSlashCommands(cwd);

  // ---- agent ----
  const { session } = opts;
  const agent = new Agent(cwd, session.id, permissions, session.messages, session.model, hooks);
  agent.planMode = opts.plan;
  if (session.model) {
    try {
      agent.switchModel(session.model);
    } catch {
      /* no key for that provider - keep the model resolved from config/env */
    }
  }
  await agent.startSession(session.messages?.length ? "resume" : "startup", undefined, session.todos);

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
  const noCron = !!opts.noCron;

  const session = await seedSession(cwd, resumeId);
  for (const c of session.subCalls ?? []) runtime.recordSubCall(c.toolUseId, c);
  const project = await buildProject(cwd, {
    session,
    mode,
    plan: !!opts.plan,
    noMcp,
    noLsp,
    askPermission: (desc, risk, preview) => runtime.askPermission(desc, risk, preview),
  });
  runtime.attach(project.agent, project.permissions);
  await rememberRecentProject(cwd);
  void refreshModelMeta();

  // ---- scheduled tasks (one process holds the lease; the rest stand by) ----
  const cron = noCron ? null : new CronScheduler({ onChange: () => hub.broadcast("cron_changed", {}) });
  if (cron) {
    const owns = await cron.start();
    console.error(owns ? "cron: scheduler active" : "cron: standby (another process owns the scheduler)");
  }
  // A stuck permission prompt with no client to answer it would hang the turn
  // forever; when the last tab/window closes, deny outstanding prompts.
  hub.onEmpty = () => {
    runtime.flushPermissions();
    runtime.flushQuestions();
  };

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

    const keepPlan = project.agent.planMode;
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

      const next = await buildProject(target, {
        session: nextSession,
        mode: project.permissions.mode,
        plan: keepPlan,
        noMcp,
        noLsp,
        askPermission: (desc, risk, preview) => runtime.askPermission(desc, risk, preview),
      });
      // Keep the same object identity: the HTTP handler holds this reference.
      Object.assign(project, next);
      runtime.subCalls.clear();
      for (const c of nextSession.subCalls ?? []) runtime.recordSubCall(c.toolUseId, c);
      runtime.attach(project.agent, project.permissions);
      await rememberRecentProject(target);
      void refreshModelMeta();
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

  /* ---------------- LLM profiles (模型配置 panel) ---------------- */

  const globalConfigFile = path.join(os.homedir(), ".node-agent", "config.json");
  const projectConfigFile = path.join(cwd, ".node-agent", "config.json");

  function hasProjectConfig(): boolean {
    const cfg = readConfigJson(projectConfigFile);
    return cfg !== null && cfg !== "corrupt" && Object.keys(cfg).length > 0;
  }

  async function listLlmProfiles(): Promise<{ activeId?: string; profiles: PublicProfile[]; projectOverrides: boolean }> {
    const store = await loadProfileStore();
    return { activeId: store.activeId, profiles: store.profiles.map(publicProfile), projectOverrides: hasProjectConfig() };
  }

  async function saveLlmProfile(input: ProfileInput): Promise<{ ok: boolean; id?: string; error?: string }> {
    try {
      const store = await loadProfileStore();
      if (input.id && !findProfile(store, input.id)) return { ok: false, error: "not found" };
      const { store: next, id } = upsertProfile(store, input);
      await saveProfileStore(next);
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function deleteLlmProfile(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const store = await loadProfileStore();
      const next = deleteProfile(store, id);
      if (next === store) return { ok: false, error: "not found" };
      // Accidentally deleting the active profile leaves the running session on
      // whatever it already resolved; only the "active" marker is dropped.
      await saveProfileStore(next);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function activateLlmProfile(id: string): Promise<{ ok: boolean; provider?: string; model?: string; error?: string; warning?: string }> {
    if (runtime.busy || runtime.switching) return { ok: false, error: "busy" };
    const store = await loadProfileStore();
    const p = findProfile(store, id);
    if (!p) return { ok: false, error: "not found" };

    const cfg: Config = { provider: p.provider, model: p.model };
    if (p.baseURL) cfg.baseURL = p.baseURL;
    if (p.apiKey) cfg.apiKey = p.apiKey;
    if (p.contextWindow) cfg.contextWindow = p.contextWindow;

    try {
      // Rebind before touching disk: a profile whose key does not resolve must
      // not leave a half-applied config behind.
      const r = project.agent.applyLlmConfig(cfg);
      // `undefined` drops a stale key (e.g. the previous profile's baseURL)
      // instead of leaking it into the next provider.
      await mergeConfigJson(globalConfigFile, {
        provider: p.provider,
        model: p.model,
        baseURL: p.baseURL?.trim() || undefined,
        apiKey: p.apiKey?.trim() || undefined,
        contextWindow: p.contextWindow ?? undefined,
      });
      await saveProfileStore({ ...store, activeId: id });
      void refreshModelMeta();
      hub.broadcast("project_changed", { cwd: project.cwd, sessionId: project.agent.sessionId, model: r.model, provider: r.provider });
      return {
        ok: true,
        provider: r.provider,
        model: r.model,
        warning: hasProjectConfig() ? "当前目录的 .node-agent/config.json 里有配置，重启后会以它为准" : undefined,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Turn a profile off. The active marker is cleared and the values it wrote
   * into the global config are dropped, so a restart falls back to env vars /
   * the defaults instead of silently keeping a "disabled" configuration.
   * The running session keeps the client it already built.
   */
  async function disableLlmProfile(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const store = await loadProfileStore();
      if (!findProfile(store, id)) return { ok: false, error: "not found" };
      if (store.activeId !== id) return { ok: true };
      await saveProfileStore({ ...store, activeId: undefined });
      await mergeConfigJson(globalConfigFile, { provider: undefined, model: undefined, baseURL: undefined, apiKey: undefined });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Learn the endpoint's context window, then let the UI re-read its state. */
  async function refreshModelMeta(): Promise<void> {
    try {
      await project.agent.refreshModelMeta();
      hub.broadcast("model_meta", {});
    } catch {
      /* best effort — the static table stays the fallback */
    }
  }

  /** List an endpoint's models from a draft config, without touching the session. */
  async function listModelsForProfile(input: ProfileInput): Promise<{ models?: string[]; note?: string; error?: string }> {
    let apiKey = input.apiKey;
    if (!apiKey && input.id) {
      const store = await loadProfileStore();
      apiKey = findProfile(store, input.id)?.apiKey;
    }

    const probe = new LLM({ provider: input.provider, model: input.model || undefined, baseURL: input.baseURL, apiKey });
    try {
      return { models: await probe.listModels() };
    } catch (err) {
      const primary = err instanceof Error ? err.message : String(err);
      // Anthropic-format gateways that live under a sub-path often have no
      // `/v1/models`; fall back to the host's OpenAI-compatible list.
      if (input.provider === "anthropic" && apiKey) {
        const viaOpenAi = await listOpenAiModels(input.baseURL, apiKey);
        if (viaOpenAi) {
          return { models: viaOpenAi, note: "来自 OpenAI 兼容 /models" };
        }
      }
      return { error: `${primary} — GET ${modelsUrl(input.provider, input.baseURL)}` };
    }
  }

  async function reloadMcp(): Promise<McpServerStatus[]> {
    if (noMcp) return [];
    try {
      await project.mcp?.shutdown();
    } catch {
      /* best effort - a stuck server must not block reconfiguration */
    }
    project.mcp = null;
    const configs = await loadMcpConfig(project.cwd);
    if (!Object.keys(configs).length) return [];
    const manager = new McpManager();
    const statuses = await manager.connectAll(configs);
    project.mcp = manager;
    return statuses;
  }

  const gui = await startGuiServer(
    {
      project,
      hub,
      runtime,
      token,
      cronScheduler: cron,
      cronDisabled: noCron,
      switchProject,
      reloadMcp,
      mcpDisabled: noMcp,
      newSession: async () => {
        // Nothing on disk yet; the next message creates the session file.
        runtime.subCalls.clear();
        await project.agent.resetSession("");
        return { id: "" };
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
        await project.agent.resetSession(loaded.meta.id, loaded.messages, loaded.meta.model, loaded.meta.todos);
        runtime.subCalls.clear();
        for (const c of loaded.subCalls) runtime.recordSubCall(c.toolUseId, c);
        if (loaded.meta.model) {
          try {
            project.agent.switchModel(loaded.meta.model);
          } catch {
            /* no key for that provider - keep current model */
          }
        }
        void refreshModelMeta();
        return null;
      },
      listSessions: async (): Promise<SessionMeta[]> => listSessions(),
      searchSessions: async (q, o) => searchSessions(q, { regex: o?.regex, limit: 20 }),
      renameSession: async (id, title) => renameSession(id, title),
      tagSession: async (id, tags) => tagSession(id, tags),
      deleteSession: async (id) => {
        // The agent must stop appending to a file that no longer exists: drop
        // back to "no session" and let the next message create a fresh one.
        const active = id === project.agent.sessionId;
        if (active && runtime.busy) return { ok: false, error: "busy" };
        const ok = await deleteSession(id);
        if (!ok) return { ok: false, error: "session not found" };
        if (active) {
          await project.agent.resetSession("");
          return { ok: true, activeCleared: true };
        }
        return { ok: true };
      },
      listLlmProfiles,
      saveLlmProfile,
      deleteLlmProfile,
      activateLlmProfile,
      disableLlmProfile,
      listModelsForProfile,
      refreshModelMeta: () => void refreshModelMeta(),
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
    runtime.flushQuestions();
    await cron?.stop();
    await gui.close();
    await project.mcp?.shutdown();
    await disposeLsp();
  };

  return { gui, shutdown };
}
