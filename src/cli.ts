#!/usr/bin/env node
import React from "react";
import path from "node:path";
import readline from "node:readline";
import { render } from "ink";
import { Agent, type AgentEvents } from "./agent.js";
import { resolveSettings, knownModelNames } from "./llm.js";
import { PermissionManager } from "./permissions.js";
import { createSession, loadSession, listSessions } from "./session.js";
import type { MessageParam, Risk } from "./types.js";
import { AgentApp } from "./ui/app.js";
import { bridge } from "./ui/bridge.js";
import { McpManager, loadMcpConfig } from "./mcp.js";
import { HookManager } from "./hooks.js";
import { loadSlashCommands, renderCommand, expandFileReferences } from "./commands.js";
import { configureLsp, disposeLsp, getLspManager, loadLspConfig } from "./lsp.js";

const ANSI = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function parseArgs(argv: string[]) {
  const args = { resume: "", print: "", model: "", provider: "", auto: false, yolo: false, plan: false, mcpServer: false, noMcp: false, noLsp: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume" && argv[i + 1]) args.resume = argv[++i];
    else if (argv[i] === "-p" && argv[i + 1]) args.print = argv[++i];
    else if (argv[i] === "--model" && argv[i + 1]) args.model = argv[++i];
    else if (argv[i] === "--provider" && argv[i + 1]) args.provider = argv[++i];
    else if (argv[i] === "--auto") args.auto = true;
    else if (argv[i] === "--yolo") args.yolo = true;
    else if (argv[i] === "--plan") args.plan = true;
    else if (argv[i] === "--mcp-server") args.mcpServer = true;
    else if (argv[i] === "--no-mcp") args.noMcp = true;
    else if (argv[i] === "--no-lsp") args.noLsp = true;
  }
  return args;
}

async function resolveSession(args: { resume: string }) {
  if (args.resume) {
    const loaded = await loadSession(args.resume);
    if (!loaded) {
      console.error(ANSI.red(`Session "${args.resume}" not found.`));
      process.exit(1);
    }
    process.chdir(loaded.meta.cwd);
    return {
      id: loaded.meta.id,
      messages: loaded.messages.length ? loaded.messages : undefined,
      cwd: loaded.meta.cwd,
      model: loaded.meta.model,
    };
  }
  const s = await createSession(process.cwd());
  return { id: s.id, messages: undefined as MessageParam[] | undefined, cwd: process.cwd(), model: undefined as string | undefined };
}

/** Restore the session's last-used model unless the user pinned one via CLI/env. */
function restoreSessionModel(agent: Agent, sessionModel: string | undefined, args: { model: string; provider?: string }) {
  if (!sessionModel || args.model || args.provider || process.env.AGENT_MODEL) return;
  try {
    agent.switchModel(sessionModel);
  } catch {
    /* key for that provider unavailable - keep the resolved default */
  }
}

async function setupMcp(args: { noMcp: boolean }): Promise<McpManager | null> {
  if (args.noMcp) return null;
  const configs = await loadMcpConfig(process.cwd());
  if (!Object.keys(configs).length) return null;
  const manager = new McpManager();
  const statuses = await manager.connectAll(configs);
  for (const s of statuses) {
    if (s.connected) console.error(ANSI.dim(`mcp: ${s.name} connected (${s.toolCount} tools)`));
    else console.error(ANSI.yellow(`mcp: ${s.name} failed: ${s.error}`));
  }
  return manager;
}

/** Enable the LSP layer unless --no-lsp; servers come from lsp.json over defaults. */
async function setupLsp(args: { noLsp: boolean }, cwd: string) {
  if (args.noLsp) {
    configureLsp(cwd, { enabled: false });
    return;
  }
  configureLsp(cwd, { enabled: true, servers: await loadLspConfig(cwd) });
}

/* ---------------- plain-text mode (-p) ---------------- */

async function runPrint(args: ReturnType<typeof parseArgs>) {
  const session = await resolveSession(args);
  const mcp = await setupMcp(args);
  await setupLsp(args, session.cwd);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  const permissions = new PermissionManager(async (desc: string, risk: Risk, preview?: string) => {
    const tag = risk === "high" ? ANSI.red("[high]") : ANSI.yellow("[write]");
    if (preview) console.log(ANSI.dim(preview.split("\n").map((l) => `  ${l}`).join("\n")));
    const answer = (await ask(`${tag} ${ANSI.bold(desc)}\n  allow? [y]es / [n]o / [a]lways / [d]eny-always > `))
      .trim()
      .toLowerCase();
    if (answer === "a" || answer === "always") return "always";
    if (answer === "d") return "always_deny";
    if (answer === "y" || answer === "yes" || answer === "") return "yes";
    return "no";
  });
  await permissions.load();
  if (args.yolo) permissions.mode = "yolo";
  else if (args.auto) permissions.mode = "auto";

  const hooks = new HookManager();
  await hooks.load(session.cwd);

  const agent = new Agent(session.cwd, session.id, permissions, session.messages, session.model, hooks);
  restoreSessionModel(agent, session.model, args);
  if (args.plan) agent.planMode = true;
  const events: AgentEvents = {
    onTextDelta: (d) => process.stdout.write(d),
    onToolStart: (_id, name, preview) => {
      process.stdout.write("\n");
      console.log(ANSI.cyan(`⚡ ${name} ${ANSI.dim(preview)}`));
    },
    onToolEnd: (_id, name, ok, preview) => {
      const first = preview.split("\n")[0];
      console.log(ok ? ANSI.dim(`  ✓ ${name}: ${first}`) : ANSI.red(`  ✗ ${name}: ${first}`));
    },
    onCompacting: () => console.log(ANSI.yellow("… compacting context …")),
    onCompacted: (before, after) =>
      console.log(ANSI.dim(`  context: ${before.toLocaleString()} → ${after.toLocaleString()} tokens`)),
  };

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  try {
    let prompt = args.print;
    const cm = /^\/([\w:-]+)\s*([\s\S]*)$/.exec(prompt.trim());
    if (cm) {
      const custom = (await loadSlashCommands(session.cwd)).get(cm[1]);
      if (custom) prompt = renderCommand(custom.template, cm[2] ? cm[2].trim().split(/\s+/) : []);
    }
    const expanded = await expandFileReferences(prompt, session.cwd);
    await agent.chat(expanded.text, controller.signal, events);
    console.log();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== "aborted") console.error(ANSI.red(`Error: ${msg}`));
    else console.log(ANSI.yellow("\n(interrupted)"));
  } finally {
    rl.close();
    await mcp?.shutdown();
  }
}

/* ---------------- interactive Ink UI ---------------- */

async function runInteractive(args: ReturnType<typeof parseArgs>) {
  const session = await resolveSession(args);
  const mcp = await setupMcp(args);
  await setupLsp(args, session.cwd);

  const permissions = new PermissionManager((desc, risk, preview) =>
    (bridge.askPermission ?? (async () => "no" as const))(desc, risk, preview),
  );
  await permissions.load();
  if (args.yolo) permissions.mode = "yolo";
  else if (args.auto) permissions.mode = "auto";

  const hooks = new HookManager();
  await hooks.load(session.cwd);
  const customCommands = await loadSlashCommands(session.cwd);

  const agent = new Agent(session.cwd, session.id, permissions, session.messages, session.model, hooks);
  restoreSessionModel(agent, session.model, args);
  if (args.plan) agent.planMode = true;

  async function handleCommand(line: string): Promise<string | null | "quit"> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    switch (cmd) {
      case "help": {
        const custom = [...customCommands.values()].map((c) => `/${c.name}`).join(" ");
        return [
          "/help · /model [name|provider:name|sonnet|opus|haiku|gpt] · /auto [on|off] · /yolo · /plan [on|off] · /mcp · /lsp · /compact · /review [base] [focus] · /permissions [clear] · /hooks · /sessions · /resume <id> · /todos · /undo [-y] · /cost [usd] · /clear · /quit",
          "file refs: @path/to/file inlines the file; Ctrl+V pastes a clipboard image",
          custom ? `custom commands: ${custom}` : "",
        ].filter(Boolean).join("\n");
      }
      case "hooks": {
        const list = hooks.list();
        return list.length
          ? list.map((h) => `${h.event}  [${h.matcher}]  ${h.command}`).join("\n")
          : "no hooks configured (~/.node-agent/hooks.json, .node-agent/hooks.json)";
      }
      case "model": {
        if (!rest[0])
          return [
            `current: ${agent.provider}:${agent.model} (context ${agent.contextWindow.toLocaleString()} tokens)`,
            `known: ${knownModelNames().join(", ")}`,
            `usage: /model <provider:name | name | alias> · /model list (query endpoint)`,
          ].join("\n");
        if (rest[0] === "list") {
          try {
            const ids = await agent.listModels();
            return ids.length
              ? `endpoint models (${ids.length}):\n${ids.slice(0, 60).join("\n")}`
              : "endpoint returned no models";
          } catch (err) {
            return ANSI.red(`endpoint does not support model listing: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        try {
          const r = agent.switchModel(rest[0]);
          return `switched to ${r.provider}:${r.model} (applies to new turns and subagents)`;
        } catch (err) {
          return ANSI.red(err instanceof Error ? err.message : String(err));
        }
      }
      case "mcp": {
        if (!mcp) return "MCP is disabled or no servers configured (~/.node-agent/mcp.json, .mcp.json)";
        if (!mcp.statuses.length) return "no MCP servers configured";
        return mcp.statuses
          .map((s) => `${s.connected ? "✓" : "✗"} ${s.name}: ${s.connected ? `${s.toolCount} tools` : s.error}`)
          .join("\n");
      }
      case "lsp": {
        const mgr = getLspManager();
        if (!mgr) return "LSP diagnostics are disabled (--no-lsp)";
        const list = mgr.status();
        return list.length
          ? list.map((s) => `✓ ${s.ext} → ${s.command} (${s.documents} open document(s))`).join("\n")
          : "no language servers started yet (they spawn on the first read/edit of a supported file)";
      }
      case "compact": {
        const before = agent.tokenEstimate();
        const did = await agent.compactNow({
          onCompacting: () => console.log(ANSI.yellow("… compacting context …")),
        });
        return did
          ? `context compacted: ${before.toLocaleString()} → ${agent.tokenEstimate().toLocaleString()} tokens`
          : "history too small to compact";
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
        console.log(ANSI.yellow(`… reviewing ${target ? `${target}...HEAD` : "uncommitted changes"} …`));
        try {
          const review = await agent.review(target, focus);
          return review;
        } catch (err) {
          return ANSI.red(`review failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      case "permissions": {
        if (rest[0] === "clear") {
          const n = await permissions.clearRules();
          return `removed ${n} rule(s)`;
        }
        const rules = permissions.getRules();
        if (!rules.length) return "no saved rules (press 'a' or 'd' at a permission prompt to add one)";
        return rules.map((r) => `${r.decision === "allow" ? "✓ allow" : "✗ deny"}  "${r.match}"`).join("\n");
      }
      case "auto": {
        const v = rest[0];
        if (v === "off") permissions.mode = "default";
        else if (v === "on") permissions.mode = "auto";
        else permissions.mode = permissions.mode === "auto" ? "default" : "auto";
        return `accept-edits mode: ${permissions.mode}`;
      }
      case "yolo":
        permissions.mode = permissions.mode === "yolo" ? "default" : "yolo";
        return `yolo mode: ${permissions.mode === "yolo" ? "ON — all permissions auto-approved" : "off"}`;
      case "plan": {
        const v = rest[0];
        if (v === "off") agent.planMode = false;
        else if (v === "on") agent.planMode = true;
        else agent.planMode = !agent.planMode;
        return agent.planMode
          ? "PLAN mode ON — the agent only explores with read-only tools, then presents a plan via exit_plan for your approval (which also switches back to normal mode)"
          : "plan mode off — normal execution";
      }
      case "sessions": {
        const list = await listSessions();
        return list.length
          ? list.slice(0, 10).map((s) => `${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.model ?? "?"}  ${s.cwd}`).join("\n")
          : "(no sessions)";
      }

      case "resume": {
        if (!rest[0]) return "usage: /resume <id>";
        const loaded = await loadSession(rest[0]);
        if (!loaded) return ANSI.red("session not found");
        agent.resetSession(loaded.meta.id, loaded.messages, loaded.meta.model);
        if (loaded.meta.model) {
          try {
            const r = agent.switchModel(loaded.meta.model);
            return `resumed ${rest[0]} (model ${r.provider}:${r.model})`;
          } catch {
            return `resumed ${rest[0]} (kept current model - no key for ${loaded.meta.model})`;
          }
        }
        return `resumed ${rest[0]}`;
      }
      case "todos": {
        const items = agent.currentTodos();
        if (!items.length) return "(empty)";
        return items.map((i) => `${i.status === "completed" ? "[x]" : i.status === "in_progress" ? "[>]" : "[ ]"} ${i.content}`).join("\n");
      }
      case "cost": {
        if (rest[0]) {
          const v = Number(rest[0].replace(/^\$/, ""));
          if (!Number.isFinite(v) || v <= 0) return "usage: /cost [usd]  (bare /cost shows this session's spend)";
          agent.costs.budgetUsd = v;
          return `session budget set to $${v.toFixed(2)} (warns at 80%, stops the turn when exhausted)`;
        }
        return agent.costs.format();
      }
      case "undo": {
        const list = (await agent.checkpointList()).filter((c) => !c.restored);
        if (!list.length) return "nothing to undo (the agent has not modified files in this session)";
        const last = list[list.length - 1];
        const target = path.isAbsolute(last.file) ? path.relative(session.cwd, last.file) || last.file : last.file;
        if (rest[0] !== "-y" && rest[0] !== "--yes") {
          return (
            `last change: #${last.id} ${last.label} → ${target} (${last.ts.slice(0, 19)})\n` +
            `run /undo -y to restore ${last.existed ? "its previous content" : "delete the created file"}`
          );
        }
        try {
          const r = await agent.undoLastCheckpoint();
          return r ? `undone: ${path.relative(session.cwd, r.file) || r.file} — ${r.action}` : "nothing to undo";
        } catch (err) {
          return ANSI.red(`undo failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      case "clear": {
        const s = await createSession(process.cwd());
        agent.resetSession(s.id);
        return `new session ${s.id}`;
      }
      case "quit":
      case "exit":
        return "quit";
      default:
        return `unknown command /${cmd} — try /help`;
    }
  }

  const app = render(
    React.createElement(AgentApp, {
      agent,
      permissions,
      sessionId: session.id,
      onCommand: handleCommand,
      customCommands,
    }),
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  await mcp?.shutdown();
  await disposeLsp();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.provider) process.env.AGENT_PROVIDER = args.provider;
  if (args.model) process.env.AGENT_MODEL = args.model;

  const settings = resolveSettings({ cwd: process.cwd() });
  if (!settings.apiKey) {
    console.error(
      ANSI.red(
        `No API key for provider "${settings.provider}". Set ${settings.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} or ~/.node-agent/config.json (project override: .node-agent/config.json).`,
      ),
    );
    process.exit(1);
  }

  if (args.mcpServer) {
    // stdio carries the JSON-RPC protocol; all logs must go to stderr.
    const { serveMcp } = await import("./mcpServer.js");
    await serveMcp(process.cwd());
    return;
  }

  if (args.print) await runPrint(args);
  else await runInteractive(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
