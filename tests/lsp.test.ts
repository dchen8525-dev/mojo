import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LspManager, configureLsp, disposeLsp, formatDiagnostics, type LspServerConfig } from "../src/lsp.js";
import { writeFileTool, editFileTool } from "../src/tools/write.js";
import { getDiagnosticsTool } from "../src/lsp.js";

/**
 * Fake language server (a plain node script): publishes one error
 * diagnostic for every line containing "ERROR" after each didOpen/didChange.
 */
const FAKE_SERVER = `
let buf = Buffer.alloc(0);
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const sep = buf.indexOf("\\r\\n\\r\\n");
    if (sep < 0) return;
    const head = buf.subarray(0, sep).toString("ascii");
    const m = /content-length:\\s*(\\d+)/i.exec(head);
    const len = parseInt(m[1], 10);
    if (buf.length < sep + 4 + len) return;
    const body = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString("utf8"));
    buf = buf.subarray(sep + 4 + len);
    handle(body);
  }
});
function send(msg) {
  const s = JSON.stringify(msg);
  process.stdout.write("Content-Length: " + Buffer.byteLength(s) + "\\r\\n\\r\\n" + s);
}
function handle(msg) {
  if (msg.id !== undefined && msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocument: { sync: { openClose: true, change: 2 } } } } });
    return;
  }
  if (msg.id !== undefined && msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.id !== undefined && msg.method !== "initialize" && msg.method !== "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
  if (msg.method === "textDocument/didOpen") {
    publish(msg.params.textDocument.uri, msg.params.textDocument.text, msg.params.textDocument.version);
  }
  if (msg.method === "textDocument/didChange") {
    const uri = msg.params.textDocument.uri;
    const version = msg.params.textDocument.version;
    const cur = texts.get(uri) || "";
    let next = cur;
    for (const ch of msg.params.contentChanges) {
      if (!ch.range) { next = ch.text; continue; }
      const so = posToOffset(cur, ch.range.start);
      const eo = posToOffset(next, ch.range.end);
      next = next.slice(0, so) + ch.text + next.slice(eo);
    }
    texts.set(uri, next);
    publish(uri, next, version);
  }
}
const texts = new Map();
function posToOffset(text, pos) {
  const lines = text.split("\\n");
  let off = 0;
  for (let i = 0; i < pos.line; i++) off += (lines[i] ?? "").length + 1;
  return off + pos.character;
}
function publish(uri, text, version) {
  texts.set(uri, text);
  const diags = [];
  text.split("\\n").forEach((line, i) => {
    const col = line.indexOf("ERROR");
    if (col >= 0) {
      diags.push({ range: { start: { line: i, character: col }, end: { line: i, character: col + 5 } }, severity: 1, source: "fake", code: 42, message: "found ERROR on this line" });
    }
  });
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diags } });
}
`;

let dir: string;
let servers: Record<string, LspServerConfig>;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-lsp-"));
  const scriptPath = path.join(dir, "fake-lsp.js");
  await fs.writeFile(scriptPath, FAKE_SERVER, "utf8");
  servers = { ".txt": { command: process.execPath, args: [scriptPath], timeout: 8000, settleDelay: 50 } };
});

afterAll(async () => {
  await disposeLsp();
  // Windows can briefly hold the temp dir while a killed server's cwd is
  // released, so retry the removal instead of failing the suite.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

describe("LspManager", () => {
  it("spawns the server, syncs a document, and collects diagnostics", async () => {
    const mgr = new LspManager(dir, servers);
    try {
      const file = path.join(dir, "a.txt");
      await fs.writeFile(file, "clean line\nthis has ERROR here\n", "utf8");
      const diags = await mgr.diagnosticsForFile(file, "clean line\nthis has ERROR here\n");
      expect(diags).not.toBeNull();
      expect(diags).toHaveLength(1);
      expect(diags![0].severity).toBe(1);
      expect(diags![0].message).toContain("found ERROR");
      expect(diags![0].range.start.line).toBe(1);
    } finally {
      await mgr.dispose();
    }
  });

  it("tracks incremental changes: stale diagnostics are replaced, cleared on fix", async () => {
    const mgr = new LspManager(dir, servers);
    try {
      const file = path.join(dir, "b.txt");
      const first = "one ERROR\n";
      await mgr.diagnosticsForFile(file, first);
      // Fix it: a big change forces a full-range replacement.
      const fixed = await mgr.diagnosticsForFile(file, "one fine\n");
      expect(fixed).toEqual([]);
      // Break it again mid-line: exercises the incremental diff path.
      const broken = await mgr.diagnosticsForFile(file, "one ERROR again\n");
      expect(broken).toHaveLength(1);
    } finally {
      await mgr.dispose();
    }
  });

  it("returns null for extensions with no configured server", async () => {
    const mgr = new LspManager(dir, servers);
    try {
      expect(await mgr.diagnosticsForFile(path.join(dir, "x.md"), "# hi")).toBeNull();
    } finally {
      await mgr.dispose();
    }
  });

  it("reports a spawn failure instead of hanging", async () => {
    const mgr = new LspManager(dir, { ".txt": { command: "definitely-not-a-real-binary-xyz", timeout: 2000 } });
    try {
      const diags = await mgr.diagnosticsForFile(path.join(dir, "c.txt"), "ERROR");
      expect(diags).toBeNull();
    } finally {
      await mgr.dispose();
    }
  });

  it("status() lists running servers with open documents", async () => {
    const mgr = new LspManager(dir, servers);
    try {
      await mgr.diagnosticsForFile(path.join(dir, "d.txt"), "ok\n");
      const st = mgr.status();
      expect(st).toHaveLength(1);
      expect(st[0].ext).toBe(".txt");
      expect(st[0].documents).toBe(1);
    } finally {
      await mgr.dispose();
    }
  });
});

describe("write_file / edit_file diagnostics", () => {
  beforeAll(async () => {
    configureLsp(dir, { enabled: true, servers });
  });

  const ctx = {
    get cwd() {
      return dir;
    },
    askPermission: async () => true,
  };

  it("write_file appends <diagnostics> with the fresh errors", async () => {
    const r = await writeFileTool.execute({ path: "w.txt", content: "hello ERROR world\n" }, ctx);
    expect(r.content).toContain("<diagnostics>");
    expect(r.content).toContain("error: w.txt:1:7");
    expect(r.content).toContain("found ERROR");
  });

  it("write_file reports a clean file", async () => {
    const r = await writeFileTool.execute({ path: "clean.txt", content: "nothing wrong\n" }, ctx);
    expect(r.content).toContain("No diagnostics for clean.txt.");
  });

  it("edit_file appends diagnostics for the edited content", async () => {
    await fs.writeFile(path.join(dir, "e.txt"), "start\nmiddle\nend\n", "utf8");
    const r = await editFileTool.execute(
      { path: "e.txt", old_string: "middle", new_string: "has ERROR now" },
      ctx,
    );
    expect(r.content).toContain("<diagnostics>");
    expect(r.content).toContain("e.txt:2:");
  });

  it("get_diagnostics checks a file without editing it", async () => {
    await fs.writeFile(path.join(dir, "g.txt"), "fine\nERROR here\n", "utf8");
    const r = await getDiagnosticsTool.execute({ path: "g.txt" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("1 error(s)");
    expect(r.content).toContain("g.txt:2:");
  });

  it("get_diagnostics errors on unsupported extensions", async () => {
    const r = await getDiagnosticsTool.execute({ path: "notes.md" }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe("formatDiagnostics", () => {
  it("summarizes severity counts and caps the listing", () => {
    const diags = Array.from({ length: 60 }, (_, i) => ({
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
      severity: i < 3 ? 1 : 2,
      message: `problem ${i}`,
    }));
    const out = formatDiagnostics("/proj", "/proj/src/a.ts", diags);
    expect(out).toContain("3 error(s), 57 warning(s)");
    expect(out).toContain("src/a.ts:1:1");
    expect(out).toContain("[... 10 more]");
  });
});
