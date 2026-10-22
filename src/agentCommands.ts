import path from "node:path";
import { COMPACT_RATIO, type Agent } from "./agent.js";
import type { PermissionManager } from "./permissions.js";
import type { HookManager } from "./hooks.js";
import type { McpManager } from "./mcp.js";
import { loadMcpConfig, mcpConfigPath, revokeProjectMcpTrust, trustProjectMcp, untrustedProjectMcp } from "./mcp.js";
import type { SlashCommand } from "./commands.js";
import { knownModelNames, resolveSettings, loadConfigLayers } from "./llm.js";
import { journalEnabled, journalDir, journalStats } from "./journal.js";
import { createSession, listSessions, loadSession, renderSessionMarkdown, renameSession, searchSessions, tagSession } from "./session.js";
import { getLspManager } from "./lsp.js";
import { createCronTask, deleteCronTask, formatCronTask, loadCronTasks, validateCron, updateCronTask } from "./cron.js";
import type { CronScheduler } from "./cronScheduler.js";

/**
 * Slash-command handling shared by the Ink terminal UI and the GUI backend.
 * Deliberately free of ANSI codes and console output: callers style the text
 * themselves, and progress messages go through `notify`.
 */

export type CommandKind = "ok" | "error";

export interface CommandResult {
  /** Multi-line text to display, or null when there is nothing to show. */
  text: string | null;
  kind: CommandKind;
  /** Set by /quit — the host UI should shut down. */
  quit?: boolean;
  /**
   * Term the surface should emphasize inside `text` (e.g. the /search query).
   * The text itself stays plain so every UI can style it its own way —
   * the terminal paints bold/inverse, the GUI wraps it in <mark>.
   */
  highlight?: string;
}

export interface CommandContext {
  agent: Agent;
  permissions: PermissionManager;
  mcp: McpManager | null;
  hooks: HookManager;
  customCommands: Map<string, SlashCommand>;
  /** Session working directory (used for relative paths and /clear). */
  cwd: string;
  /** Progress messages (long-running commands like /review and /compact). */
  notify?: (message: string) => void;
  /** Aborts long-running commands when the host UI stops the command. */
  signal?: AbortSignal;
  /** Local scheduler for /cron run; absent in hosts that do not schedule. */
  cronScheduler?: CronScheduler | null;
}

/** Names of the built-in commands (for /help listings and the GUI palette). */
export const BUILTIN_COMMANDS = [
  "help", "model", "auto", "yolo", "plan", "mcp", "lsp", "compact", "context", "review",
  "permissions", "hooks", "sessions", "search", "resume", "fork", "rename", "tag", "export", "todos", "undo", "cost", "cron", "doctor", "clear", "quit",
] as const;

/**
 * Commands whose behavior depends on the ANSI palette / terminal theme state.
 * They stay in cli.ts and must be intercepted before delegating here; the GUI
 * implements its own equivalents against its theme.
 */
export const TERMINAL_ONLY_COMMANDS = ["theme"] as const;

export async function runAgentCommand(line: string, ctx: CommandContext): Promise<CommandResult> {
  const { agent, permissions, mcp, hooks, customCommands, cwd } = ctx;
  const notify = ctx.notify ?? (() => {});
  const [cmd, ...rest] = line.slice(1).split(/\s+/);

  switch (cmd) {
    case "help": {
      const custom = [...customCommands.values()].map((c) => `/${c.name}`).join(" ");
      return {
        kind: "ok",
        text: [
          "/help · /model [name|provider:name|sonnet|opus|haiku|gpt] · /auto [on|off] · /yolo · /plan [on|off] · /mcp [trust|revoke] · /lsp · /compact · /review [base] [focus] · /permissions [clear] · /hooks [trust|revoke] · /sessions [--cwd <dir>] [--title <词>] [--tag <tag>] [--fork-of <id>] [N] · /search [-r] <term> · /resume <id> · /fork [N] [名称] · /rename <名称> · /tag [+<tag> | -<tag> | clear] · /export [md|json] [路径] · /todos · /cron [add <分> <时> <日> <月> <周> <提示词> | on|off|run|rm <id>] · /doctor · /undo [-y] [--force] · /cost [usd | all | by session|model|day | export [path]] · /clear · /quit",
          "file refs: @path/to/file inlines the file; Ctrl+V pastes a clipboard image",
          custom ? `custom commands: ${custom}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "doctor": {
      const lines: string[] = [];
      const settings = resolveSettings({ cwd });
      const layers = loadConfigLayers(cwd);
      const key = settings.apiKey;
      lines.push(
        key
          ? `✓ api key: set (${key.slice(0, 3)}…${key.slice(-4)}, never displayed; source: ${
              layers.project.apiKey ? "project config" : layers.global.apiKey ? "global config" : "environment"
            })`
          : "✗ api key: MISSING — set ANTHROPIC_API_KEY / OPENAI_API_KEY or add it to config.json",
      );
      lines.push(`✓ model: ${agent.provider}:${agent.model} (context ${agent.contextWindow.toLocaleString()} tokens)${settings.baseURL ? ` · endpoint ${settings.baseURL}` : ""}`);
      const used = agent.tokenEstimate();
      const pct = ((used / agent.contextWindow) * 100).toFixed(1);
      lines.push(`${used > agent.contextWindow * COMPACT_RATIO ? "⚠" : "✓"} context: ${used.toLocaleString()} / ${agent.contextWindow.toLocaleString()} tokens (${pct}%; compact at ${(COMPACT_RATIO * 100).toFixed(0)}%)`);
      const sessionMsgs = agent.debugMessages().length;
      lines.push(`✓ session: ${agent.sessionId} · ${sessionMsgs} message(s)`);

      const rules = permissions.getRules().length;
      const projectRules = permissions.getProjectRules().length;
      const sessionRules = permissions.getSessionRules().length;
      lines.push(`✓ permissions: mode ${permissions.mode} · ${rules} global / ${projectRules} project / ${sessionRules} session rule(s)`);

      if (!mcp) {
        lines.push("⚠ mcp: disabled for this run (--no-mcp)");
      } else if (!mcp.statuses.length) {
        lines.push("✓ mcp: no servers configured");
      } else {
        const ok = mcp.statuses.filter((s) => s.connected);
        const tools = mcp.statuses.reduce((sum, s) => sum + (s.connected ? s.toolCount : 0), 0);
        lines.push(`${ok.length === mcp.statuses.length ? "✓" : "⚠"} mcp: ${ok.length}/${mcp.statuses.length} connected · ${tools} tool(s)`);
        for (const s of mcp.statuses) if (!s.connected) lines.push(`  ✗ ${s.name}: ${s.error ?? "connection failed"}`);
      }

      const hookCount = hooks.list().length;
      const untrusted = hooks.untrustedProjectHooks();
      lines.push(
        untrusted
          ? `⚠ hooks: ${hookCount} loaded · project hooks NOT loaded (untrusted): ${untrusted.file} — /hooks trust to approve`
          : `✓ hooks: ${hookCount} loaded`,
      );

      const cron = ctx.cronScheduler;
      lines.push(
        !cron
          ? "⚠ cron: scheduler not running in this host"
          : cron.isOwner
            ? "✓ cron: scheduler active (owner)"
            : cron.isStarted
              ? "✓ cron: scheduler standby (another process owns the lease)"
              : "⚠ cron: scheduler created but not started",
      );

      const lspMgr = getLspManager();
      if (!lspMgr) {
        lines.push("⚠ lsp: not started (--no-lsp or not configured)");
      } else {
        const st = lspMgr.status();
        const bad = st.filter((s) => s.error);
        lines.push(`${bad.length ? "⚠" : "✓"} lsp: ${st.length} server(s) · ${st.reduce((sum, s) => sum + s.documents, 0)} document(s)`);
        for (const s of bad) lines.push(`  ✗ ${s.ext}: ${s.error}`);
      }

      if (journalEnabled()) {
        const stats = await journalStats(journalDir());
        lines.push(`✓ journal: on (AGENT_JOURNAL) · ${stats.files} file(s), ${(stats.bytes / 1024 / 1024).toFixed(1)} MB in ${journalDir()}`);
      } else {
        lines.push("⚠ journal: off — set AGENT_JOURNAL=1 to record model I/O to ~/.node-agent/journal");
      }
      return { kind: "ok", text: lines.join("\n") };
    }
    case "hooks": {
      if (rest[0] === "trust") {
        const n = await hooks.trustProjectHooks(cwd);
        if (n === 0) return { kind: "error", text: `no project hooks file at ${path.join(cwd, ".node-agent", "hooks.json")}` };
        return { kind: "ok", text: `trusted project hooks for this workspace — ${n} hook(s) active (re-approval is required after the file changes)` };
      }
      if (rest[0] === "revoke") {
        const removed = await hooks.revokeProjectHooks(cwd);
        return {
          kind: "ok",
          text: removed ? "revoked hook trust for this workspace; project hooks will not run" : "this workspace has no hook trust to revoke",
        };
      }
      const list = hooks.list();
      const untrusted = hooks.untrustedProjectHooks();
      const lines = list.length
        ? list.map((h) => `${h.event}  [${h.matcher}]  ${h.command}`)
        : ["no hooks configured (~/.node-agent/hooks.json, .node-agent/hooks.json)"];
      if (untrusted) {
        lines.push(
          `⚠ project hooks NOT loaded (untrusted): ${untrusted.file}`,
          `  review the file, then run /hooks trust to approve this exact version (/hooks revoke to undo)`,
        );
      }
      return { kind: "ok", text: lines.join("\n") };
    }
    case "model": {
      if (!rest[0])
        return {
          kind: "ok",
          text: [
            `current: ${agent.provider}:${agent.model} (context ${agent.contextWindow.toLocaleString()} tokens)`,
            `known: ${knownModelNames().join(", ")}`,
            `usage: /model <provider:name | name | alias> · /model list (query endpoint)`,
          ].join("\n"),
        };
      if (rest[0] === "list") {
        try {
          const ids = await agent.listModels(ctx.signal);
          return {
            kind: "ok",
            text: ids.length ? `endpoint models (${ids.length}):\n${ids.slice(0, 60).join("\n")}` : "endpoint returned no models",
          };
        } catch (err) {
          return { kind: "error", text: `endpoint does not support model listing: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      try {
        const r = agent.switchModel(rest[0]);
        return { kind: "ok", text: `switched to ${r.provider}:${r.model} (applies to new turns and subagents)` };
      } catch (err) {
        return { kind: "error", text: err instanceof Error ? err.message : String(err) };
      }
    }
    case "mcp": {
      if (rest[0] === "trust") {
        const trusted = await trustProjectMcp(cwd);
        if (!trusted) return { kind: "error", text: `no project MCP config at ${mcpConfigPath("project", cwd)}` };
        if (!mcp) return { kind: "ok", text: `trusted ${trusted.file} — MCP is disabled for this run (--no-mcp)` };
        await mcp.reload(await loadMcpConfig(cwd));
        const connected = mcp.statuses.filter((s) => s.connected).length;
        return {
          kind: "ok",
          text: `trusted project MCP config for this workspace — ${connected}/${mcp.statuses.length} server(s) connected (re-approval is required after the file changes)`,
        };
      }
      if (rest[0] === "revoke") {
        const removed = await revokeProjectMcpTrust(cwd);
        if (!removed) return { kind: "ok", text: "this workspace has no MCP trust to revoke" };
        await mcp?.reload(await loadMcpConfig(cwd));
        return { kind: "ok", text: "revoked project MCP trust; project servers will not connect" };
      }
      const untrusted = await untrustedProjectMcp(cwd);
      const warning = untrusted
        ? `⚠ project MCP servers not connected (untrusted): ${untrusted.file} — run /mcp trust to approve`
        : "";
      if (!mcp) {
        return {
          kind: "ok",
          text: warning || "MCP is disabled or no servers configured (~/.node-agent/mcp.json, .mcp.json)",
        };
      }
      const lines = mcp.statuses.map(
        (s) => `${s.connected ? "✓" : "✗"} ${s.name}: ${s.connected ? `${s.toolCount} tools${s.kind ? ` (${s.kind})` : ""}` : s.error}`,
      );
      if (!lines.length && !warning) return { kind: "ok", text: "no MCP servers configured" };
      return { kind: "ok", text: [warning, ...lines].filter(Boolean).join("\n") };
    }
    case "lsp": {
      const mgr = getLspManager();
      if (!mgr) return { kind: "ok", text: "LSP diagnostics are disabled (--no-lsp)" };
      const list = mgr.status();
      return {
        kind: "ok",
        text: list.length
          ? list.map((s) => `✓ ${s.ext} → ${s.command} (${s.documents} open document(s))`).join("\n")
          : "no language servers started yet (they spawn on the first read/edit of a supported file)",
      };
    }
    case "compact": {
      const before = agent.tokenEstimate();
      const did = await agent.compactNow({ onCompacting: () => notify("… compacting context …") }, ctx.signal);
      return {
        kind: "ok",
        text: did
          ? `context compacted: ${before.toLocaleString()} → ${agent.tokenEstimate().toLocaleString()} tokens`
          : "history too small to compact",
      };
    }
    case "review": {
      // /review [base] [focus text] - no arg reviews uncommitted changes.
      const known = ["main", "master", "HEAD", "origin/main", "develop"];
      let target: string | undefined;
      let focus: string | undefined;
      if (rest[0] && (known.includes(rest[0]) || rest[0].startsWith("origin/") || /^[0-9a-f]{7,40}$/.test(rest[0]))) {
        target = rest[0];
        focus = rest.slice(1).join(" ") || undefined;
      } else {
        focus = rest.join(" ") || undefined;
      }
      notify(`… reviewing ${target ? `${target}...HEAD` : "uncommitted changes"} …`);
      try {
        const review = await agent.review(target, focus, ctx.signal);
        return { kind: "ok", text: review };
      } catch (err) {
        return { kind: "error", text: `review failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case "context": {
      const used = agent.tokenEstimate();
      const window = agent.contextWindow;
      const pct = (used / window) * 100;
      return {
        kind: "ok",
        text:
          `context: ${used.toLocaleString()} / ${window.toLocaleString()} tokens (${pct.toFixed(1)}%)\n` +
          `${agent.debugMessages().length} messages loaded\n` +
          `— tokens include the API's exact input count as an anchor plus a CJK-aware estimate of anything not yet billed\n` +
          `— at ~${(COMPACT_RATIO * 100).toFixed(0)}% of the window the agent auto-compacts; /compact forces it early`,
      };
    }
    case "permissions": {
      if (rest[0] === "clear") {
        const { global, project } = await permissions.clearRules();
        const parts = [`removed ${global} global rule(s)`];
        if (project) parts.push(`cleared ${project} project rule(s) from memory (they reload from .node-agent/permissions.json)`);
        return { kind: "ok", text: parts.join("; ") };
      }
      const rules = permissions.getRules();
      if (!rules.length) return { kind: "ok", text: "no saved rules (press 'a' or 'd' at a permission prompt to add one)" };
      return { kind: "ok", text: rules.map((r) => `${r.decision === "allow" ? "✓ allow" : "✗ deny"}  "${r.match}"`).join("\n") };
    }
    case "auto": {
      const v = rest[0];
      if (v === "off") permissions.mode = "default";
      else if (v === "on") permissions.mode = "auto";
      else permissions.mode = permissions.mode === "auto" ? "default" : "auto";
      return { kind: "ok", text: `accept-edits mode: ${permissions.mode}` };
    }
    case "yolo":
      permissions.mode = permissions.mode === "yolo" ? "default" : "yolo";
      return {
        kind: "ok",
        text: `yolo mode: ${permissions.mode === "yolo" ? "ON — all permissions auto-approved" : "off"}`,
      };
    case "plan": {
      const v = rest[0];
      if (v === "off") agent.planMode = false;
      else if (v === "on") agent.planMode = true;
      else agent.planMode = !agent.planMode;
      return {
        kind: "ok",
        text: agent.planMode
          ? "PLAN mode ON — the agent only explores with read-only tools, then presents a plan via exit_plan for your approval (which also switches back to normal mode)"
          : "plan mode off — normal execution",
      };
    }
    case "sessions": {
      // /sessions [--cwd <dir>] [--title <kw>] [--tag <tag>] [--fork-of <id>] [N]
      const words = [...rest];
      let cwdFilter = "";
      let titleFilter = "";
      let tagFilter = "";
      let forkOf = "";
      let limit = 10;
      for (let i = 0; i < words.length; i++) {
        if ((words[i] === "--cwd" || words[i] === "--title" || words[i] === "--tag" || words[i] === "--fork-of") && words[i + 1] !== undefined) {
          const v = words[++i];
          if (words[i - 1] === "--cwd") cwdFilter = v.toLowerCase();
          else if (words[i - 1] === "--title") titleFilter = v.toLowerCase();
          else if (words[i - 1] === "--fork-of") forkOf = v.toLowerCase();
          else tagFilter = v.toLowerCase();
        } else if (/^\d+$/.test(words[i])) {
          limit = Math.max(1, Number(words[i]));
        }
      }
      const all = await listSessions();
      let list = all;
      if (cwdFilter) list = list.filter((s) => s.cwd.toLowerCase().includes(cwdFilter));
      if (titleFilter)
        list = list.filter((s) => (s.title ?? "").toLowerCase().includes(titleFilter) || s.id.includes(titleFilter));
      if (tagFilter) list = list.filter((s) => (s.tags ?? []).some((t) => t.toLowerCase().includes(tagFilter)));
      if (forkOf) list = list.filter((s) => (s.forkedFrom ?? "").toLowerCase().startsWith(forkOf));
      const desc = [cwdFilter && `cwd~"${cwdFilter}"`, titleFilter && `title~"${titleFilter}"`, tagFilter && `tag~"${tagFilter}"`, forkOf && `fork-of ${forkOf}`]
        .filter(Boolean)
        .join(" & ");
      if (!list.length) return { kind: "ok", text: desc ? `(no sessions match ${desc})` : "(no sessions)" };
      const shown = list.slice(0, limit);
      // Branch lineage: children per session id (counted across all sessions).
      const childCount = new Map<string, number>();
      for (const s of all) if (s.forkedFrom) childCount.set(s.forkedFrom, (childCount.get(s.forkedFrom) ?? 0) + 1);
      const head = desc
        ? `${list.length} match${desc ? ` (${desc})` : ""}`
        : `${shown.length} shown / ${all.length} total`;
      return {
        kind: "ok",
        text:
          `${head} — resume with /resume <id>\n` +
          shown
            .map((s) => {
              const tags = s.tags?.length ? ` [${s.tags.join(",")}]` : "";
              const fork = s.forkedFrom ? `⑂${s.forkedFrom.slice(0, 8)}${s.forkPoint ? `@${s.forkPoint}` : ""} ` : "";
              const children = childCount.get(s.id) ? ` (+${childCount.get(s.id)}⑂)` : "";
              return `${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.model ?? "?"}  ${fork}${s.title ? `"${s.title}" ` : ""}${tags}${children}${s.cwd}`;
            })
            .join("\n"),
      };
    }
    case "search": {
      if (!rest.length) return { kind: "error", text: "usage: /search [-r] <term>  (case-insensitive; -r enables regex)" };
      let regex = false;
      const words = [...rest];
      if (words[0] === "-r" || words[0] === "--regex") {
        regex = true;
        words.shift();
      }
      const query = words.join(" ");
      if (!query.trim()) return { kind: "error", text: "usage: /search [-r] <term>" };
      const hits = await searchSessions(query, { excludeId: agent.sessionId, regex });
      if (!hits.length) return { kind: "ok", text: `no sessions match "${query}" (searched message text, tool calls, tags, and titles)` };
      const lines = hits.map((h) => {
        const label = h.meta.title ? `"${h.meta.title}"` : h.meta.cwd;
        const tags = h.meta.tags?.length ? ` [${h.meta.tags.join(",")}]` : "";
        const where = h.matches ? `${h.matches} msg${h.matches > 1 ? "s" : ""}` : h.tagMatch ? "tag" : "title";
        const snip = h.snippet ? `\n    ${h.snippet}` : "";
        return `${h.meta.id}  ${h.meta.updatedAt.slice(0, 16)}  ${label}${tags}  (${where})${snip}`;
      });
      return {
        kind: "ok",
        text: [`${hits.length} session(s) match "${query}" — resume with /resume <id>`, ...lines].join("\n"),
        // Surfaces emphasize the raw query (substring match); regex syntax is
        // not re-applied here — close enough for visual emphasis.
        highlight: query,
      };
    }
    case "export": {
      const loaded = await loadSession(agent.sessionId);
      if (!loaded || !loaded.messages.length) return { kind: "error", text: "nothing to export yet (the conversation is empty)" };
      const format = (rest[0] ?? "md").toLowerCase();
      if (format !== "md" && format !== "json") return { kind: "error", text: "usage: /export [md|json] [path]" };
      const positional = rest.slice(1);
      const body =
        format === "json"
          ? JSON.stringify({ meta: loaded.meta, messages: loaded.messages }, null, 2)
          : renderSessionMarkdown(loaded.meta, loaded.messages);
      const defaultName = `${agent.sessionId}.${format}`;
      const out = path.resolve(cwd, positional[0] ?? defaultName);
      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(out, body, "utf8");
      } catch (err) {
        return { kind: "error", text: `export failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { kind: "ok", text: `exported ${loaded.messages.length} messages → ${out} (${body.length.toLocaleString()} chars)` };
    }
    case "resume": {
      if (!rest[0]) return { kind: "error", text: "usage: /resume <id>" };
      const loaded = await loadSession(rest[0]);
      if (!loaded) return { kind: "error", text: "session not found" };
      await agent.resetSession(loaded.meta.id, loaded.messages, loaded.meta.model, loaded.meta.todos);
      if (loaded.meta.model) {
        try {
          const r = agent.switchModel(loaded.meta.model);
          return { kind: "ok", text: `resumed ${rest[0]} (model ${r.provider}:${r.model})` };
        } catch {
          return { kind: "ok", text: `resumed ${rest[0]} (kept current model - no key for ${loaded.meta.model})` };
        }
      }
      return { kind: "ok", text: `resumed ${rest[0]}` };
    }
    case "rename": {
      // /rename <title> — name the *current* session (shown in /sessions and
      // the GUI sidebar). An empty title clears the name.
      const title = rest.join(" ").trim();
      const ok = await renameSession(agent.sessionId, title);
      if (!ok) return { kind: "error", text: "session not found (nothing renamed yet)" };
      return {
        kind: "ok",
        text: title ? `renamed session ${agent.sessionId} to "${title}"` : `cleared the name on session ${agent.sessionId}`,
      };
    }
    case "tag": {
      // /tag                     — show the current session's tags
      // /tag +a +b / tag word    — add (a bare word adds too)
      // /tag -a                  — remove (case-insensitive)
      // /tag clear               — remove all
      const words = [...rest].filter(Boolean);
      if (!words.length) {
        const cur = (await loadSession(agent.sessionId))?.meta.tags ?? [];
        return { kind: "ok", text: cur.length ? `tags: ${cur.join(", ")}` : "(no tags — /tag +name adds, -name removes, clear empties)" };
      }
      if (words[0] === "clear") {
        await tagSession(agent.sessionId, []);
        return { kind: "ok", text: `cleared tags on session ${agent.sessionId}` };
      }
      const cur = (await loadSession(agent.sessionId))?.meta.tags ?? [];
      const next = new Set(cur);
      for (const w of words) {
        if (w.startsWith("-") && w.length > 1) {
          for (const t of [...next]) if (t.toLowerCase() === w.slice(1).toLowerCase()) next.delete(t);
        } else if (w.startsWith("+") && w.length > 1) {
          next.add(w.slice(1));
        } else if (!w.startsWith("-")) {
          next.add(w);
        }
      }
      const saved = await tagSession(agent.sessionId, [...next]);
      return saved?.length
        ? { kind: "ok", text: `tags: ${saved.join(", ")}` }
        : { kind: "ok", text: "(no tags)" };
    }
    case "todos": {
      const items = agent.currentTodos();
      if (!items.length) return { kind: "ok", text: "(empty)" };
      return {
        kind: "ok",
        text: items.map((i) => `${i.status === "completed" ? "[x]" : i.status === "in_progress" ? "[>]" : "[ ]"} ${i.content}`).join("\n"),
      };
    }
    case "cost": {
      const sub = rest[0]?.toLowerCase();
      if (sub === "all" || sub === "by" || sub === "export") {
        const { aggregateUsage, flushUsage, formatAggregates, readUsageLog, usageToCsv } = await import("./usage.js");
        await flushUsage(); // make this session's in-flight turns visible to the ledger read
        if (sub === "export") {
          const entries = await readUsageLog();
          if (!entries.length) return { kind: "ok", text: "nothing to export (the usage ledger is empty)" };
          const out = rest[1] ? path.resolve(cwd, rest[1]) : path.join(cwd, "usage.csv");
          const { writeFile } = await import("node:fs/promises");
          await writeFile(out, usageToCsv(entries), "utf8");
          return { kind: "ok", text: `exported ${entries.length} usage rows to ${out}` };
        }
        if (sub === "all") {
          const entries = await readUsageLog();
          if (!entries.length) return { kind: "ok", text: "no usage recorded yet (the ledger opens at ~/.node-agent/usage.jsonl)" };
          const usd = entries.reduce((t, e) => t + (e.u ?? 0), 0);
          const req = entries.length;
          const sessions = new Set(entries.map((e) => e.s)).size;
          const days = new Set(entries.map((e) => e.t.slice(0, 10))).size;
          const inTok = entries.reduce((t, e) => t + e.i + (e.cr ?? 0) + (e.cw ?? 0), 0);
          const outTok = entries.reduce((t, e) => t + e.o, 0);
          return { kind: "ok", text: `all time: $${usd.toFixed(4)} · ${req} requests · ${sessions} sessions · ${days} days\nin ${fmtK(inTok)} / out ${fmtK(outTok)} tokens` };
        }
        const dim = (rest[1] ?? "model").toLowerCase();
        if (dim !== "session" && dim !== "model" && dim !== "day") {
          return { kind: "error", text: "usage: /cost by [session|model|day]" };
        }
        return { kind: "ok", text: formatAggregates(aggregateUsage(await readUsageLog(), dim), dim) };
      }
      if (rest[0]) {
        const v = Number(rest[0].replace(/^\$/, ""));
        if (!Number.isFinite(v) || v <= 0) return { kind: "error", text: "usage: /cost [usd | all | by session|model|day | export [path]]" };
        agent.costs.budgetUsd = v;
        return { kind: "ok", text: `session budget set to $${v.toFixed(2)} (warns at 80%, stops the turn when exhausted)` };
      }
      return { kind: "ok", text: agent.costs.format() };
    }
    case "undo": {
      const list = (await agent.checkpointList()).filter((c) => !c.restored);
      if (!list.length) return { kind: "ok", text: "nothing to undo (the agent has not modified files in this session)" };
      const last = list[list.length - 1];
      const target = path.isAbsolute(last.file) ? path.relative(cwd, last.file) || last.file : last.file;
      if (rest[0] !== "-y" && rest[0] !== "--yes") {
        return {
          kind: "ok",
          text:
            `last change: #${last.id} ${last.label} → ${target} (${last.ts.slice(0, 19)})\n` +
            `run /undo -y to restore ${last.existed ? "its previous content" : "delete the created file"}`,
        };
      }
      try {
        const r = await agent.undoLastCheckpoint(rest.includes("--force"));
        if (!r) return { kind: "ok", text: "nothing to undo" };
        const rel = path.relative(cwd, r.file) || r.file;
        if (r.conflict) {
          return {
            kind: "error",
            text:
              `undo refused: ${rel} ${r.reason}. The checkpoint was kept; review the file, ` +
              `then run /undo -y --force to discard the later change.`,
          };
        }
        return { kind: "ok", text: `undone: ${rel} — ${r.action}` };
      } catch (err) {
        return { kind: "error", text: `undo failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case "rewind": {
      // /rewind — list checkpoints; /rewind <id|latest> [-y] [--force] — roll
      // the workspace back to just before that checkpoint (all active edits
      // after it are folded in; files the agent created are deleted).
      const all = await agent.checkpointList();
      if (!all.length) return { kind: "ok", text: "no checkpoints (the agent has not modified files in this session)" };
      const rel = (f: string) => (path.isAbsolute(f) ? path.relative(cwd, f) || f : f);
      const yes = rest.includes("-y") || rest.includes("--yes");
      const force = rest.includes("--force");
      const arg = rest.find((r) => !r.startsWith("-"));
      if (!arg) {
        const lines = all
          .map((c) => `#${c.id} ${c.ts.slice(0, 19)} ${c.label} → ${rel(c.file)}${c.restored ? " (already undone)" : ""}`)
          .join("\n");
        return {
          kind: "ok",
          text: `${lines}\nrun /rewind <id> to preview rolling the workspace back to just before that point; add -y to apply (--force overrides conflicts).`,
        };
      }
      const targetId = arg === "latest" ? Math.max(...all.map((c) => c.id)) : Number(arg);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return { kind: "error", text: "usage: /rewind [id | latest] [-y] [--force]" };
      }
      const out = await agent.rewindToCheckpoint(targetId, { dryRun: !yes, force });
      if (!out) return { kind: "error", text: `no checkpoint #${targetId} in this session (run /rewind to list)` };
      if (out.conflicts.length) {
        return {
          kind: "error",
          text:
            `rewind refused — later changes conflict:\n` +
            out.conflicts.map((c) => `  ${rel(c.file)}: ${c.reason}`).join("\n") +
            `\nReview the files, then run /rewind ${targetId} -y --force to discard them.`,
        };
      }
      if (out.dryRun) {
        if (!out.applied.length) return { kind: "ok", text: `nothing to rewind (the edits at or after #${targetId} are already undone)` };
        return {
          kind: "ok",
          text:
            `would roll back ${out.applied.length} file(s) to just before #${targetId}:\n` +
            out.applied.map((a) => `  ${rel(a.file)}: ${a.action}`).join("\n") +
            `\nrun /rewind ${targetId} -y to apply.`,
        };
      }
      if (!out.applied.length) return { kind: "ok", text: `nothing to rewind (the edits at or after #${targetId} are already undone)` };
      return {
        kind: "ok",
        text: `rewound ${out.applied.length} file(s) to just before #${targetId}:\n` + out.applied.map((a) => `  ${rel(a.file)}: ${a.action}`).join("\n"),
      };
    }
    case "fork": {
      // /fork [N] [title] — branch into a new session keeping the first N
      // messages (default: all). A leading integer is the count, the rest is an
      // optional title. The original session file is left untouched.
      const total = agent.getMessages().length;
      if (!total) return { kind: "error", text: "nothing to fork yet (the conversation is empty)" };
      const fromId = agent.sessionId;
      let keep = total;
      const titleParts = [...rest];
      if (rest[0] && /^\d+$/.test(rest[0])) {
        keep = parseInt(rest[0], 10);
        titleParts.shift();
      }
      const title = titleParts.join(" ").trim() || undefined;
      const newId = await agent.fork(keep, title);
      if (!newId) return { kind: "error", text: `nothing kept: /fork ${keep} would drop the whole history — try a larger N` };
      const kept = agent.getMessages().length;
      return {
        kind: "ok",
        text:
          `forked into session ${newId}` +
          (title ? ` "${title}"` : "") +
          ` (kept ${kept}/${total} messages${kept < keep ? ", rounded back to a clean boundary" : ""})\n` +
          `now continuing in the fork; ${fromId} is unchanged — get back with /resume ${fromId}\n` +
          `list this branch with /sessions --fork-of ${fromId}`,
      };
    }
    case "cron": {
      const sub = (rest[0] ?? "").toLowerCase();
      if (!sub) {
        try {
          const tasks = await loadCronTasks();
          if (!tasks.length) {
            return {
              kind: "ok",
              text: "no scheduled tasks — /cron add <minute> <hour> <day> <month> <weekday> <prompt>",
            };
          }
          return { kind: "ok", text: [`${tasks.length} scheduled task(s):`, ...tasks.map(formatCronTask)].join("\n") };
        } catch (err) {
          return { kind: "error", text: err instanceof Error ? err.message : String(err) };
        }
      }
      if (sub === "add") {
        const cron = rest.slice(1, 6).join(" ");
        const prompt = rest.slice(6).join(" ").trim();
        if (rest.length < 7 || !prompt) {
          return {
            kind: "error",
            text: "usage: /cron add <minute> <hour> <day> <month> <weekday> <prompt>\n  e.g. /cron add 0 9 * * 1-5 总结昨天的提交并列出风险",
          };
        }
        const check = validateCron(cron);
        if (!check.ok) return { kind: "error", text: check.error };
        try {
          const task = await createCronTask({ cron, prompt, cwd });
          return {
            kind: "ok",
            text: `created ${task.id} "${task.name}" (${task.cron}); next run ${new Date(task.nextRunAt).toLocaleString()}`,
          };
        } catch (err) {
          return { kind: "error", text: err instanceof Error ? err.message : String(err) };
        }
      }
      const id = rest[1] ?? "";
      if (!id) return { kind: "error", text: "usage: /cron on|off|run|rm <id>" };
      if (sub === "rm" || sub === "delete") {
        try {
          const ok = await deleteCronTask(id);
          return ok ? { kind: "ok", text: `deleted ${id}` } : { kind: "error", text: `scheduled task "${id}" not found` };
        } catch (err) {
          return { kind: "error", text: err instanceof Error ? err.message : String(err) };
        }
      }
      if (sub === "on" || sub === "off") {
        try {
          const task = await updateCronTask(id, { enabled: sub === "on" });
          return {
            kind: "ok",
            text: `${task.enabled ? "enabled" : "paused"} ${task.id}; ${task.enabled ? `next run ${new Date(task.nextRunAt).toLocaleString()}` : "it will not fire until enabled"}`,
          };
        } catch (err) {
          return { kind: "error", text: err instanceof Error ? err.message : String(err) };
        }
      }
      if (sub === "run") {
        if (!ctx.cronScheduler) return { kind: "error", text: "the scheduler is not running in this host (start without --no-cron)" };
        const r = await ctx.cronScheduler.runNowDetached(id);
        return r.ok
          ? { kind: "ok", text: `started ${id}; the result appears in /cron and ~/.node-agent/cron-runs` }
          : { kind: "error", text: r.error ?? "run failed" };
      }
      return { kind: "error", text: "usage: /cron [add <min> <hour> <day> <month> <weekday> <prompt> | on|off|run|rm <id>]" };
    }
    case "clear": {
      const s = await createSession(cwd);
      await agent.resetSession(s.id);
      return { kind: "ok", text: `new session ${s.id}` };
    }
    case "quit":
    case "exit":
      return { kind: "ok", text: null, quit: true };
    default:
      return { kind: "error", text: `unknown command /${cmd} — try /help` };
  }
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
