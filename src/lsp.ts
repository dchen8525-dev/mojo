import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { relPath, resolvePath, str, truncate, describeError } from "./tools/utils.js";

/**
 * Minimal built-in LSP client: a stdio JSON-RPC connection plus an
 * LspManager that lazily spawns one language server per file kind, syncs
 * documents the agent reads or edits (didOpen / incremental didChange), and
 * collects textDocument/publishDiagnostics notifications.
 *
 * After every write_file / edit_file the fresh diagnostics for the touched
 * file are appended to the tool result, so the model sees compile errors
 * immediately instead of guessing.
 */

interface DiagnosticPosition {
  line: number;
  character: number;
}

export interface LspDiagnostic {
  range: { start: DiagnosticPosition; end: DiagnosticPosition };
  severity?: number; // 1 error, 2 warning, 3 info, 4 hint
  code?: number | string;
  source?: string;
  message: string;
}

export interface LspServerConfig {
  command: string;
  args?: string[];
  /** Max ms to wait for the server to publish diagnostics after a change. */
  timeout?: number;
  /** Extra ms to let a second publish settle (some servers publish twice). */
  settleDelay?: number;
}

/** File extension -> server launch config. Override via configureLsp(). */
export const DEFAULT_SERVERS: Record<string, LspServerConfig> = {
  ".ts": { command: "typescript-language-server", args: ["--stdio"] },
  ".tsx": { command: "typescript-language-server", args: ["--stdio"] },
  ".js": { command: "typescript-language-server", args: ["--stdio"] },
  ".jsx": { command: "typescript-language-server", args: ["--stdio"] },
  ".mjs": { command: "typescript-language-server", args: ["--stdio"] },
  ".cjs": { command: "typescript-language-server", args: ["--stdio"] },
  ".py": { command: "pyright-langserver", args: ["--stdio"] },
};

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_SETTLE = 250;
const MAX_FORMATTED_DIAGNOSTICS = 50;

const REQUEST_TIMEOUT = 10_000;

/* ---------------- JSON-RPC over stdio ---------------- */

type MessageHandler = (params: unknown) => void;

class LspConnection {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private notificationHandlers = new Map<string, MessageHandler>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  readonly stderrTail: string[] = [];

  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) this.stderrTail.push(line);
      }
      if (this.stderrTail.length > 30) this.stderrTail.splice(0, this.stderrTail.length - 30);
    });
    this.child.on("close", () => this.failAll(new Error("LSP server exited")));
    this.child.on("error", (err) => {
      this.failAll(err);
      this.closed = true;
    });
  }

  get dead(): boolean {
    return this.closed;
  }

  onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const headers = this.buffer.subarray(0, sep).toString("ascii");
      const lenMatch = /content-length:\s*(\d+)/i.exec(headers);
      if (!lenMatch) {
        this.buffer = this.buffer.subarray(sep + 4);
        continue;
      }
      const len = parseInt(lenMatch[1], 10);
      if (this.buffer.length < sep + 4 + len) return; // wait for the full body
      const body = this.buffer.subarray(sep + 4, sep + 4 + len).toString("utf8");
      this.buffer = this.buffer.subarray(sep + 4 + len);
      let msg: {
        id?: number | string;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }) {
    if (msg.id !== undefined && msg.method === undefined) {
      // Response to one of our requests.
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || "LSP request failed"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server-initiated request: answer null so it never blocks on us.
      this.write({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    if (msg.method) {
      const h = this.notificationHandlers.get(msg.method);
      if (h) h(msg.params);
    }
  }

  onNotification(method: string, handler: MessageHandler) {
    this.notificationHandlers.set(method, handler);
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private write(msg: unknown) {
    if (this.closed || !this.child.stdin?.writable) return;
    const body = JSON.stringify(msg);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.closed = true;
  }

  async dispose() {
    if (this.closed) return;
    try {
      await this.request("shutdown", null, 1500);
      this.notify("exit", null);
    } catch {
      /* server may not answer - kill it below anyway */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 1500);
      this.child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.child.kill();
    this.failAll(new Error("LSP connection disposed"));
  }
}

/* ---------------- document sync helpers ---------------- */

/** Longest common prefix / suffix; the middle is the changed range. */
function diffRange(oldText: string, newText: string): { startOffset: number; endOffset: number; text: string } {
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { startOffset: start, endOffset: oldEnd, text: newText.slice(start, newEnd) };
}

function offsetToPosition(text: string, offset: number): DiagnosticPosition {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

/* ---------------- LspManager ---------------- */

interface ServerInstance {
  ext: string;
  cfg: LspServerConfig;
  conn: LspConnection;
  rootUri: string;
  ready: Promise<void>;
}

interface DocState {
  version: number;
  text: string;
  publishedVersion: number;
  publishedAt: number;
}

export interface LspManagerStatus {
  ext: string;
  command: string;
  documents: number;
  error?: string;
}

export class LspManager {
  readonly cwd: string;
  private servers = new Map<string, ServerInstance>();
  private starting = new Map<string, Promise<ServerInstance>>();
  private docs = new Map<string, DocState>(); // abs path -> state
  private diagnostics = new Map<string, { version: number; diags: LspDiagnostic[] }>();
  private serversConfig: Record<string, LspServerConfig>;

  constructor(cwd: string, servers?: Record<string, LspServerConfig>) {
    this.cwd = path.resolve(cwd);
    this.serversConfig = servers ?? DEFAULT_SERVERS;
  }

  serverConfigFor(filePath: string): LspServerConfig | undefined {
    return this.serversConfig[path.extname(filePath).toLowerCase()];
  }

  private async ensureServer(ext: string): Promise<ServerInstance> {
    const inflight = this.starting.get(ext);
    if (inflight) return inflight;
    const p = this.startServer(ext);
    this.starting.set(ext, p);
    try {
      return await p;
    } finally {
      this.starting.delete(ext);
    }
  }

  private async startServer(ext: string): Promise<ServerInstance> {
    const existing = this.servers.get(ext);
    if (existing) {
      await existing.ready.catch(() => {});
      if (!existing.conn.dead) return existing;
      this.servers.delete(ext); // crashed - respawn on next use
    }
    const cfg = this.serversConfig[ext];
    if (!cfg) throw new Error(`no LSP server configured for ${ext}`);

    const conn = new LspConnection(cfg.command, cfg.args ?? [], this.cwd);
    const inst: ServerInstance = {
      ext,
      cfg,
      conn,
      rootUri: pathToFileURL(this.cwd).href,
      ready: Promise.resolve(),
    };
    inst.ready = (async () => {
      conn.onNotification("textDocument/publishDiagnostics", (params) => this.onPublish(params));
      await conn.request("initialize", {
        processId: process.pid,
        rootUri: inst.rootUri,
        capabilities: {
          textDocument: {
            synchronization: { didSave: false, willSave: false, dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { configuration: false, didChangeWatchedFiles: { dynamicRegistration: false } },
        },
        workspaceFolders: [{ uri: inst.rootUri, name: path.basename(this.cwd) }],
      });
      conn.notify("initialized", {});
    })();
    this.servers.set(ext, inst);
    try {
      await inst.ready;
    } catch (err) {
      this.servers.delete(ext);
      await conn.dispose().catch(() => {});
      throw err;
    }
    return inst;
  }

  private onPublish(params: unknown) {
    const p = params as { uri?: string; diagnostics?: LspDiagnostic[] };
    if (!p?.uri) return;
    let file: string;
    try {
      file = fileURLToPath(p.uri);
    } catch {
      return;
    }
    file = path.normalize(file);
    const doc = this.docs.get(file);
    this.diagnostics.set(file, {
      version: doc?.version ?? 0,
      diags: Array.isArray(p.diagnostics) ? p.diagnostics : [],
    });
    if (doc) {
      doc.publishedVersion = doc.version;
      doc.publishedAt = Date.now();
    }
  }

  /**
   * Push the file's current content to its language server (open on first
   * sight, incremental didChange afterwards). Returns null when no server
   * is configured for the extension.
   */
  async syncFile(absPath: string, content: string): Promise<{ version: number } | null> {
    const file = path.normalize(absPath);
    const ext = path.extname(file).toLowerCase();
    if (!this.serversConfig[ext]) return null;

    const inst = await this.ensureServer(ext);
    const uri = pathToFileURL(file).href;
    const prev = this.docs.get(file);
    if (!prev) {
      this.docs.set(file, { version: 1, text: content, publishedVersion: 0, publishedAt: 0 });
      inst.conn.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: ext.slice(1), version: 1, text: content },
      });
    } else {
      if (prev.text === content) return { version: prev.version };
      const { startOffset, endOffset, text } = diffRange(prev.text, content);
      const version = prev.version + 1;
      this.docs.set(file, { version, text: content, publishedVersion: prev.publishedVersion, publishedAt: prev.publishedAt });
      inst.conn.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [
          {
            range: { start: offsetToPosition(prev.text, startOffset), end: offsetToPosition(prev.text, endOffset) },
            text,
          },
        ],
      });
    }
    return { version: prev ? prev.version + 1 : 1 };
  }

  /** Wait for the server to publish diagnostics for the given synced version. */
  async waitForDiagnostics(absPath: string, version: number, timeoutMs?: number): Promise<LspDiagnostic[]> {
    const file = path.normalize(absPath);
    const ext = path.extname(file).toLowerCase();
    const cfg = this.serversConfig[ext];
    const deadline = Date.now() + (timeoutMs ?? cfg?.timeout ?? DEFAULT_TIMEOUT);
    for (;;) {
      const entry = this.diagnostics.get(file);
      if (entry && entry.version >= version) {
        const settle = cfg?.settleDelay ?? DEFAULT_SETTLE;
        if (settle > 0) await sleep(settle);
        const after = this.diagnostics.get(file);
        return (after && after.version >= version ? after.diags : entry.diags) ?? [];
      }
      if (Date.now() >= deadline) return entry?.diags ?? [];
      await sleep(100);
    }
  }

  /** syncFile + waitForDiagnostics in one call; null when no server applies. */
  async diagnosticsForFile(absPath: string, content: string): Promise<LspDiagnostic[] | null> {
    try {
      const synced = await this.syncFile(absPath, content);
      if (!synced) return null;
      return await this.waitForDiagnostics(absPath, synced.version);
    } catch {
      return null; // LSP problems must never break the edit itself
    }
  }

  status(): LspManagerStatus[] {
    return [...this.servers.values()].map((s) => ({
      ext: s.ext,
      command: `${s.cfg.command} ${(s.cfg.args ?? []).join(" ")}`.trim(),
      documents: [...this.docs.keys()].filter((f) => path.extname(f).toLowerCase() === s.ext).length,
    }));
  }

  async dispose() {
    await Promise.all([...this.servers.values()].map((s) => s.conn.dispose().catch(() => {})));
    this.servers.clear();
    this.docs.clear();
    this.diagnostics.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/* ---------------- formatting ---------------- */

const SEVERITY = ["", "error", "warning", "info", "hint"];

export function formatDiagnostics(cwd: string, file: string, diags: LspDiagnostic[]): string {
  const rel = relPath(cwd, file).replaceAll("\\", "/");
  if (!diags.length) return `No diagnostics for ${rel}.`;
  const errors = diags.filter((d) => d.severity === 1).length;
  const warnings = diags.filter((d) => d.severity === 2).length;
  const lines = diags.slice(0, MAX_FORMATTED_DIAGNOSTICS).map((d) => {
    const sev = SEVERITY[d.severity ?? 0] || "info";
    const code = d.code !== undefined ? ` ${String(d.code)}` : "";
    const src = d.source ? `${d.source}` : "lsp";
    return `  ${sev}: ${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} [${src}${code}] ${d.message.split("\n")[0]}`;
  });
  const more = diags.length > MAX_FORMATTED_DIAGNOSTICS ? `\n  [... ${diags.length - MAX_FORMATTED_DIAGNOSTICS} more]` : "";
  return `${rel}: ${errors} error(s), ${warnings} warning(s)\n${lines.join("\n")}${more}`;
}

/* ---------------- process-wide singleton ---------------- */

/**
 * Load server overrides from ~/.node-agent/lsp.json and <cwd>/.node-agent/lsp.json
 * (project wins): { ".go": { "command": "gopls", "args": ["serve"], "timeout": 15000 } }
 */
export async function loadLspConfig(cwd: string): Promise<Record<string, LspServerConfig>> {
  const out: Record<string, LspServerConfig> = { ...DEFAULT_SERVERS };
  for (const f of [
    path.join(os.homedir(), ".node-agent", "lsp.json"),
    path.join(cwd, ".node-agent", "lsp.json"),
  ]) {
    try {
      const raw = JSON.parse((await fs.readFile(f, "utf8")).replace(/^/, ""));
      for (const [ext, cfg] of Object.entries(raw.servers ?? raw)) {
        if (cfg && typeof (cfg as LspServerConfig).command === "string") out[ext.toLowerCase()] = cfg as LspServerConfig;
      }
    } catch {
      /* file optional */
    }
  }
  return out;
}

let manager: LspManager | null = null;
let configured = false;

/** Wire the LSP layer into the agent (called from the CLI entry points). */
export function configureLsp(cwd: string, opts: { enabled: boolean; servers?: Record<string, LspServerConfig> }) {
  if (!opts.enabled) {
    void manager?.dispose();
    manager = null;
    configured = true;
    return;
  }
  if (manager) void manager.dispose();
  manager = new LspManager(cwd, opts.servers);
  configured = true;
}

export function getLspManager(): LspManager | null {
  if (!configured) {
    // Not explicitly configured (e.g. tool used from a subagent or a test):
    // enable by default so diagnostics still work.
    configureLsp(process.cwd(), { enabled: true });
  }
  return manager;
}

export async function disposeLsp() {
  await manager?.dispose();
  manager = null;
  configured = false;
}

/**
 * Diagnostic hint appended to write_file / edit_file results. Never throws:
 * a missing or broken language server must not fail a successful edit.
 */
export async function diagnosticsHint(cwd: string, absPath: string, content: string): Promise<string> {
  const mgr = getLspManager();
  if (!mgr || !mgr.serverConfigFor(absPath)) return "";
  const diags = await mgr.diagnosticsForFile(absPath, content);
  if (diags === null) return "";
  return `\n\n<diagnostics>\n${formatDiagnostics(cwd, absPath, diags)}\n</diagnostics>`;
}

/* ---------------- get_diagnostics tool ---------------- */

export const getDiagnosticsTool: Tool = {
  name: "get_diagnostics",
  description:
    "Ask the language server for compile errors and warnings in a file (TypeScript/JavaScript " +
    "via typescript-language-server, Python via pyright when installed). write_file and " +
    "edit_file already return diagnostics for the file they touch, so use this to check a " +
    "file you only read, or to re-check one after manual fixes.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to check (absolute or working-directory-relative)." },
    },
    required: ["path"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const abs = resolvePath(ctx.cwd, str(input, "path"));
      const mgr = getLspManager();
      if (!mgr) return { content: "LSP support is disabled (started with --no-lsp).", isError: true };
      if (!mgr.serverConfigFor(abs)) {
        return { content: `No language server configured for "${path.extname(abs)}" files.`, isError: true };
      }
      const content = await fs.readFile(abs, "utf8");
      const diags = await mgr.diagnosticsForFile(abs, content);
      if (diags === null) return { content: "The language server could not be started.", isError: true };
      return { content: truncate(formatDiagnostics(ctx.cwd, abs, diags)) };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};
