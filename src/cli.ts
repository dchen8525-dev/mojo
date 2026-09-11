#!/usr/bin/env node
import React from "react";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { render } from "ink";
import { Agent, COMPACT_RATIO, type AgentEvents } from "./agent.js";
import { resolveSettings } from "./llm.js";
import { PermissionManager } from "./permissions.js";
import type { MessageParam, Risk } from "./types.js";
import { AgentApp } from "./ui/app.js";
import { bridge } from "./ui/bridge.js";
import { McpManager, loadMcpConfig } from "./mcp.js";
import { HookManager } from "./hooks.js";
import { loadSlashCommands, renderCommand, expandFileReferences } from "./commands.js";
import { configureLsp, disposeLsp, loadLspConfig } from "./lsp.js";
import { renderSessionMarkdown, createSession, loadSession, listSessions } from "./session.js";
import { runAgentCommand, type CommandContext } from "./agentCommands.js";
import {
  ansiHelpers,
  ansiPaint,
  getTheme,
  parseThemeName,
  resolveTheme,
  resolveThemeAsync,
  saveTheme,
  THEME_NAMES,
  type Theme,
  type ThemeName,
} from "./ui/theme.js";

let ANSI = ansiHelpers(getTheme("dark"));

/** A compact 20-char usage bar, warning-colored once past the compact threshold. */
function contextBar(pct: number, theme: Theme): string {
  const filled = Math.max(0, Math.min(20, Math.round(pct / 5)));
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  return pct >= COMPACT_RATIO * 100 ? ansiPaint(theme.error, bar) : ANSI.dim(bar);
}

function parseArgs(argv: string[]) {
  const args = { resume: "", cont: false, print: "", model: "", provider: "", theme: "", auto: false, yolo: false, plan: false, mcpServer: false, noMcp: false, noLsp: false, help: false, version: false, exportId: "", exportFormat: "md" as "md" | "json", gui: false, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume" && argv[i + 1]) args.resume = argv[++i];
    else if (argv[i] === "--continue") args.cont = true;
    else if (argv[i] === "-p" && argv[i + 1]) args.print = argv[++i];
    else if (argv[i] === "--export" && argv[i + 1]) args.exportId = argv[++i];
    else if (argv[i] === "--format" && argv[i + 1] && (argv[++i] === "md" || argv[i] === "json")) args.exportFormat = argv[i] as "md" | "json";
    else if (argv[i] === "--model" && argv[i + 1]) args.model = argv[++i];
    else if (argv[i] === "--provider" && argv[i + 1]) args.provider = argv[++i];
    else if (argv[i] === "--theme" && argv[i + 1]) args.theme = argv[++i];
    else if (argv[i] === "--port" && argv[i + 1]) args.port = Number(argv[++i]) || 0;
    else if (argv[i] === "--auto") args.auto = true;
    else if (argv[i] === "--yolo") args.yolo = true;
    else if (argv[i] === "--plan") args.plan = true;
    else if (argv[i] === "--mcp-server") args.mcpServer = true;
    else if (argv[i] === "--no-mcp") args.noMcp = true;
    else if (argv[i] === "--no-lsp") args.noLsp = true;
    else if (argv[i] === "--gui") args.gui = true;
    else if (argv[i] === "-h" || argv[i] === "--help") args.help = true;
    else if (argv[i] === "-v" || argv[i] === "--version") args.version = true;
  }
  return args;
}

async function resolveSession(args: { resume: string; cont: boolean }) {
  if (args.resume) {
    const loaded = await loadSession(args.resume);
    if (!loaded) {
      console.error(ANSI.error(`Session "${args.resume}" not found.`));
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
  // --continue: jump into the most recently updated session, if any.
  if (args.cont) {
    const sessions = await listSessions();
    if (sessions.length) {
      const latest = sessions[0]; // listSessions sorts by updatedAt desc
      const loaded = await loadSession(latest.id);
      if (loaded) {
        process.chdir(loaded.meta.cwd);
        console.error(ANSI.dim(`continuing session ${latest.id} (${latest.updatedAt.slice(0, 16)}, ${latest.model ?? "?"})`));
        return {
          id: loaded.meta.id,
          messages: loaded.messages.length ? loaded.messages : undefined,
          cwd: loaded.meta.cwd,
          model: loaded.meta.model,
        };
      }
    }
    console.error(ANSI.warn("no previous session to continue - starting a new one."));
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
    else console.error(ANSI.warn(`mcp: ${s.name} failed: ${s.error}`));
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
  const resolved = resolveTheme({ theme: args.theme, cwd: session.cwd });
  ANSI = ansiHelpers(resolved.theme);
  const mcp = await setupMcp(args);
  await setupLsp(args, session.cwd);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  const permissions = new PermissionManager(async (desc: string, risk: Risk, preview?: string) => {
    const tag = risk === "high" ? ANSI.error("[high]") : ANSI.warn("[write]");
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
  await permissions.loadProject(session.cwd);
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
      console.log(ANSI.accent(`⚡ ${name} ${ANSI.dim(preview)}`));
    },
    onToolEnd: (_id, name, ok, preview) => {
      const first = preview.split("\n")[0];
      console.log(ok ? ANSI.dim(`  ✓ ${name}: ${first}`) : ANSI.error(`  ✗ ${name}: ${first}`));
    },
    onCompacting: () => console.log(ANSI.warn("… compacting context …")),
    onCompacted: (before, after) =>
      console.log(ANSI.dim(`  context: ${before.toLocaleString()} → ${after.toLocaleString()} tokens`)),
  };

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const started = Date.now();
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
    if (msg !== "aborted") console.error(ANSI.error(`Error: ${msg}`));
    else console.log(ANSI.warn("\n(interrupted)"));
  } finally {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const used = agent.tokenEstimate();
    const cost = agent.costs.totalUsd();
    const costStr = cost > 0 ? ` · $${cost.toFixed(4)}` : "";
    console.error(ANSI.dim(`— ${secs}s · ${used.toLocaleString()} tok · ` +
      `${agent.provider}:${agent.model}${costStr}`));
    rl.close();
    await mcp?.shutdown();
  }
}

/** Export a saved session to Markdown (or raw JSON) in the current directory. */
async function runExport(args: { exportId: string; exportFormat: "md" | "json" }) {
  const s = await loadSession(args.exportId);
  if (!s) {
    console.error(ANSI.error(`Session "${args.exportId}" not found.`));
    process.exitCode = 1;
    return;
  }
  const ext = args.exportFormat === "json" ? "json" : "md";
  const outFile = path.resolve(process.cwd(), `${args.exportId}.${ext}`);
  const body = args.exportFormat === "json"
    ? JSON.stringify({ meta: s.meta, messages: s.messages }, null, 2)
    : renderSessionMarkdown(s.meta, s.messages);
  await fs.writeFile(outFile, body, "utf8");
  console.log(ANSI.dim(`exported ${args.exportId} → ${outFile} (${body.length.toLocaleString()} chars)`));
}

/* ---------------- interactive Ink UI ---------------- */

async function runInteractive(args: ReturnType<typeof parseArgs>) {
  const session = await resolveSession(args);
  // Ask the terminal for its background before Ink takes over stdin.
  let resolved = await resolveThemeAsync({ theme: args.theme, cwd: session.cwd });
  let themeName: ThemeName = resolved.name;
  ANSI = ansiHelpers(resolved.theme);
  const mcp = await setupMcp(args);
  await setupLsp(args, session.cwd);

  const permissions = new PermissionManager((desc, risk, preview) =>
    (bridge.askPermission ?? (async () => "no" as const))(desc, risk, preview),
  );
  await permissions.load();
  await permissions.loadProject(session.cwd);
  if (args.yolo) permissions.mode = "yolo";
  else if (args.auto) permissions.mode = "auto";

  const hooks = new HookManager();
  await hooks.load(session.cwd);
  const customCommands = await loadSlashCommands(session.cwd);

  const agent = new Agent(session.cwd, session.id, permissions, session.messages, session.model, hooks);
  restoreSessionModel(agent, session.model, args);
  if (args.plan) agent.planMode = true;

  const cmdCtx: CommandContext = {
    agent,
    permissions,
    mcp,
    hooks,
    customCommands,
    cwd: session.cwd,
    notify: (m) => console.log(ANSI.warn(m)),
  };
  async function handleCommand(line: string): Promise<string | null | "quit"> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    // Terminal-only commands stay here: the shared runner is deliberately free
    // of ANSI/theme concerns so the GUI can reuse it with its own styling.
    if (cmd === "theme") {
      if (!rest[0]) {
        const shown = themeName === "auto" ? `auto → ${resolved.theme.id}` : themeName;
        return [
          `theme: ${shown}  (from ${resolved.source})`,
          `available: ${THEME_NAMES.join(" · ")}`,
          `usage: /theme <${THEME_NAMES.join("|")}> — persists to ~/.node-agent/config.json`,
          `one-off: agent --theme <name> · AGENT_THEME=<name> · AGENT_BACKGROUND=dark|light (auto only)`,
        ].join("\n");
      }
      const next = parseThemeName(rest[0]);
      if (!next) return ANSI.error(`unknown theme "${rest[0]}" — try ${THEME_NAMES.join(", ")}`);
      resolved = await resolveThemeAsync({ theme: next, cwd: session.cwd });
      themeName = next;
      ANSI = ansiHelpers(resolved.theme);
      bridge.setTheme?.(resolved.theme);
      const label = `theme: ${next}${next === "auto" ? ` → ${resolved.theme.id}` : ""}`;
      try {
        const { file, shadowed } = await saveTheme(next, { cwd: session.cwd });
        return (
          `${label} — saved to ${file}` +
          (shadowed ? "\nnote: this project pins a theme in .node-agent/config.json, which shadows the global setting" : "")
        );
      } catch (err) {
        return `${label} — applied for this session (could not save: ${err instanceof Error ? err.message : String(err)})`;
      }
    }
    if (cmd === "context") {
      const used = agent.tokenEstimate();
      const window = agent.contextWindow;
      const pct = (used / window) * 100;
      const bar = contextBar(pct, resolved.theme);
      return (
        `context: ${used.toLocaleString()} / ${window.toLocaleString()} tokens (${pct.toFixed(1)}%) ${bar}\n` +
        `${agent.debugMessages().length} messages loaded\n` +
        `— tokens include the API's exact input count as an anchor plus a CJK-aware estimate of anything not yet billed\n` +
        `— at ~${(COMPACT_RATIO * 100).toFixed(0)}% of the window the agent auto-compacts; /compact forces it early`
      );
    }
    const r = await runAgentCommand(line, cmdCtx);
    if (r.quit) return "quit";
    if (!r.text) return null;
    return r.kind === "error" ? ANSI.error(r.text) : r.text;
  }

  const app = render(
    React.createElement(AgentApp, {
      agent,
      permissions,
      sessionId: session.id,
      onCommand: handleCommand,
      customCommands,
      initialTheme: resolved.theme,
    }),
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  await mcp?.shutdown();
  await disposeLsp();
}

const require = createRequire(import.meta.url);
const VERSION = (require("../package.json") as { version: string }).version;

const USAGE = `Usage: agent [options]

  Start interactive mode:
    agent [--resume <id> | --continue] [--model <spec>] [--provider <name>] [--theme <name>] [--auto | --yolo]

  Single-shot print mode:
    agent -p "prompt" [--model <spec>] [--theme <name>]

  Export a saved session (to .md/.json):
    agent --export <session-id> [--format md|json]

  Options:
    --resume <id>      Resume a saved session
    --continue         Jump to the most recently updated session (no need for id)
    -p <prompt>        Single-shot print mode
    --export <id>      Export a saved session to Markdown/JSON in the working directory
    --format md|json   Output format (default md)
    --model <spec>     Override model (e.g. anthropic:claude-sonnet-4-5 or just sonnet)
    --provider <name>  Override provider (anthropic|openai)
    --theme <name>     UI theme: dark | light | auto (follow the terminal)
    --auto             Auto-approve non-high-risk writes without prompting
    --yolo             Auto-approve everything (unsafe)
    --plan             Start in plan mode (read-only exploration only)
    --mcp-server       Expose this agent as an MCP server over stdio
    --gui              Run the local browser GUI instead of the terminal UI
    --port <n>         Port for --gui (default: random free port)
    --no-mcp           Don't connect to any local MCP server
    --no-lsp           Don't start any language server
    -h, --help         Show this help
    -v, --version      Show version
`;

/* ---------------- GUI mode (local browser) ---------------- */

async function runGui(args: ReturnType<typeof parseArgs>) {
  const { startGuiBackend } = await import("./gui/backend.js");
  const { openBrowser } = await import("./gui/openBrowser.js");

  const backend = await startGuiBackend({
    cwd: process.cwd(),
    resume: args.resume || undefined,
    auto: args.auto,
    yolo: args.yolo,
    plan: args.plan,
    noMcp: args.noMcp,
    noLsp: args.noLsp,
    port: args.port,
    onQuit: () => {
      void backend.shutdown().then(() => process.exit(0));
    },
  });

  console.error(ANSI.success(`GUI ready: ${backend.gui.url}`));
  console.error(ANSI.dim("Ctrl+C to stop."));
  openBrowser(backend.gui.url);

  await new Promise<void>((resolve) => process.on("SIGINT", () => resolve()));
  await backend.shutdown();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.provider) process.env.AGENT_PROVIDER = args.provider;
  if (args.model) process.env.AGENT_MODEL = args.model;
  if (args.theme) {
    const parsed = parseThemeName(args.theme);
    if (!parsed) {
      console.error(ANSI.error(`Unknown theme "${args.theme}" — try ${THEME_NAMES.join(", ")}.`));
      process.exit(1);
    }
    process.env.AGENT_THEME = parsed;
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }
  if (args.exportId) {
    await runExport(args);
    return;
  }

  const settings = resolveSettings({ cwd: process.cwd() });
  if (!settings.apiKey) {
    console.error(
      ANSI.error(
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

  if (args.gui) await runGui(args);
  else if (args.print) await runPrint(args);
  else await runInteractive(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
