#!/usr/bin/env node
import React from "react";
import readline from "node:readline";
import { render } from "ink";
import { Agent, type AgentEvents } from "./agent.js";
import { resolveSettings } from "./llm.js";
import { PermissionManager } from "./permissions.js";
import { createSession, loadSession } from "./session.js";
import type { MessageParam, Risk } from "./types.js";
import { AgentApp } from "./ui/app.js";
import { bridge } from "./ui/bridge.js";
import { McpManager, loadMcpConfig } from "./mcp.js";
import { HookManager } from "./hooks.js";
import { loadSlashCommands, renderCommand, expandFileReferences } from "./commands.js";
import { configureLsp, disposeLsp, loadLspConfig } from "./lsp.js";
import { runAgentCommand, type CommandContext } from "./agentCommands.js";

const ANSI = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function parseArgs(argv: string[]) {
  const args = { resume: "", print: "", model: "", provider: "", auto: false, yolo: false, plan: false, mcpServer: false, noMcp: false, noLsp: false, gui: false, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume" && argv[i + 1]) args.resume = argv[++i];
    else if (argv[i] === "-p" && argv[i + 1]) args.print = argv[++i];
    else if (argv[i] === "--model" && argv[i + 1]) args.model = argv[++i];
    else if (argv[i] === "--provider" && argv[i + 1]) args.provider = argv[++i];
    else if (argv[i] === "--port" && argv[i + 1]) args.port = Number(argv[++i]) || 0;
    else if (argv[i] === "--auto") args.auto = true;
    else if (argv[i] === "--yolo") args.yolo = true;
    else if (argv[i] === "--plan") args.plan = true;
    else if (argv[i] === "--mcp-server") args.mcpServer = true;
    else if (argv[i] === "--no-mcp") args.noMcp = true;
    else if (argv[i] === "--no-lsp") args.noLsp = true;
    else if (argv[i] === "--gui") args.gui = true;
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

  const cmdCtx: CommandContext = {
    agent,
    permissions,
    mcp,
    hooks,
    customCommands,
    cwd: session.cwd,
    notify: (m) => console.log(ANSI.yellow(m)),
  };
  async function handleCommand(line: string): Promise<string | null | "quit"> {
    const r = await runAgentCommand(line, cmdCtx);
    if (r.quit) return "quit";
    if (!r.text) return null;
    return r.kind === "error" ? ANSI.red(r.text) : r.text;
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

  console.error(ANSI.green(`GUI ready: ${backend.gui.url}`));
  console.error(ANSI.dim("Ctrl+C to stop."));
  openBrowser(backend.gui.url);

  await new Promise<void>((resolve) => process.on("SIGINT", () => resolve()));
  await backend.shutdown();
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

  if (args.gui) await runGui(args);
  else if (args.print) await runPrint(args);
  else await runInteractive(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
