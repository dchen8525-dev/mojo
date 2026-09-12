import path from "node:path";
import { COMPACT_RATIO, type Agent } from "./agent.js";
import type { PermissionManager } from "./permissions.js";
import type { HookManager } from "./hooks.js";
import type { McpManager } from "./mcp.js";
import type { SlashCommand } from "./commands.js";
import { knownModelNames } from "./llm.js";
import { createSession, listSessions, loadSession, renameSession } from "./session.js";
import { getLspManager } from "./lsp.js";

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
}

/** Names of the built-in commands (for /help listings and the GUI palette). */
export const BUILTIN_COMMANDS = [
  "help", "model", "auto", "yolo", "plan", "mcp", "lsp", "compact", "context", "review",
  "permissions", "hooks", "sessions", "resume", "fork", "rename", "todos", "undo", "cost", "clear", "quit",
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
          "/help · /model [name|provider:name|sonnet|opus|haiku|gpt] · /auto [on|off] · /yolo · /plan [on|off] · /mcp · /lsp · /compact · /review [base] [focus] · /permissions [clear] · /hooks · /sessions · /resume <id> · /fork [N] [名称] · /rename <名称> · /todos · /undo [-y] · /cost [usd] · /clear · /quit",
          "file refs: @path/to/file inlines the file; Ctrl+V pastes a clipboard image",
          custom ? `custom commands: ${custom}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "hooks": {
      const list = hooks.list();
      return {
        kind: "ok",
        text: list.length
          ? list.map((h) => `${h.event}  [${h.matcher}]  ${h.command}`).join("\n")
          : "no hooks configured (~/.node-agent/hooks.json, .node-agent/hooks.json)",
      };
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
          const ids = await agent.listModels();
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
      if (!mcp) return { kind: "ok", text: "MCP is disabled or no servers configured (~/.node-agent/mcp.json, .mcp.json)" };
      if (!mcp.statuses.length) return { kind: "ok", text: "no MCP servers configured" };
      return {
        kind: "ok",
        text: mcp.statuses
          .map((s) => `${s.connected ? "✓" : "✗"} ${s.name}: ${s.connected ? `${s.toolCount} tools` : s.error}`)
          .join("\n"),
      };
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
      const did = await agent.compactNow({ onCompacting: () => notify("… compacting context …") });
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
        const review = await agent.review(target, focus);
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
      const list = await listSessions();
      return {
        kind: "ok",
        text: list.length
          ? list.slice(0, 10).map((s) => `${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.model ?? "?"}  ${s.cwd}`).join("\n")
          : "(no sessions)",
      };
    }
    case "resume": {
      if (!rest[0]) return { kind: "error", text: "usage: /resume <id>" };
      const loaded = await loadSession(rest[0]);
      if (!loaded) return { kind: "error", text: "session not found" };
      await agent.resetSession(loaded.meta.id, loaded.messages, loaded.meta.model);
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
    case "todos": {
      const items = agent.currentTodos();
      if (!items.length) return { kind: "ok", text: "(empty)" };
      return {
        kind: "ok",
        text: items.map((i) => `${i.status === "completed" ? "[x]" : i.status === "in_progress" ? "[>]" : "[ ]"} ${i.content}`).join("\n"),
      };
    }
    case "cost": {
      if (rest[0]) {
        const v = Number(rest[0].replace(/^\$/, ""));
        if (!Number.isFinite(v) || v <= 0) return { kind: "error", text: "usage: /cost [usd]  (bare /cost shows this session's spend)" };
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
        const r = await agent.undoLastCheckpoint();
        return { kind: "ok", text: r ? `undone: ${path.relative(cwd, r.file) || r.file} — ${r.action}` : "nothing to undo" };
      } catch (err) {
        return { kind: "error", text: `undo failed: ${err instanceof Error ? err.message : String(err)}` };
      }
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
          `now continuing in the fork; ${fromId} is unchanged — get back with /resume ${fromId}`,
      };
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
