import http from "node:http";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunningBackend } from "../src/gui/backend.js";

/**
 * SSE replay fixtures: pin the GUI's server→client event contract.
 *
 * Part 1 drives the REAL GUI backend against a scripted Anthropic endpoint,
 * captures the SSE frames of two golden scenarios (a plain tool round and a
 * permission prompt with diff preview), normalizes volatile values, and
 * compares them against checked-in fixtures under tests/fixtures/sse/. Any
 * payload or ordering drift between server and UI fails here instead of
 * breaking the frontend silently. Regenerate with AGENT_SSE_CAPTURE=1.
 *
 * Part 2 replays the normalized fixtures into happy-dom app.js through the
 * FakeEventSource, asserting the UI outcomes end to end: live text, tool
 * cards, the permission modal's structured diff, and turn completion.
 */

const CAPTURE = /^(1|true)$/i.test(process.env.AGENT_SSE_CAPTURE ?? "");
const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "sse");

const NOTES_BODY = "golden content\n";
const GOLDEN_PROMPT = "summarize notes.txt";
const PERM_PROMPT = "create out.txt";
const GOLDEN_FINAL = "The notes say: golden content.";
const PERM_FINAL = "File created.";

/** Events that make up the turn contract; everything else (boot noise) is skipped. */
const TURN_EVENTS = new Set([
  "turn_start",
  "round_start",
  "text_delta",
  "thinking_delta",
  "tool_use_start",
  "tool_start",
  "tool_end",
  "sub_tool",
  "usage",
  "compacting",
  "compacted",
  "retry",
  "permission_request",
  "turn_end",
  "turn_error",
]);

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "AGENT_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalCwd = process.cwd();

let home: string;
let project: string;
let mock: http.Server;
let backend: RunningBackend;
let base: string;
let messageRequests = 0;

type ScriptedStream = Array<[string, unknown]>;

function textBlock(index: number, text: string): ScriptedStream {
  return [
    ["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index }],
  ];
}

function toolUseBlock(index: number, id: string, name: string, input: Record<string, unknown>): ScriptedStream {
  return [
    ["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }],
    [
      "content_block_delta",
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    ],
    ["content_block_stop", { type: "content_block_stop", index }],
  ];
}

function scriptedTurn(blocks: ScriptedStream[], stopReason: string): ScriptedStream {
  return [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
    ],
    ...blocks,
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 3 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

const scripts: ScriptedStream[] = [
  // Turn 1 (golden), round 1: some text, then read the notes.
  scriptedTurn(
    [...textBlock(0, "Let me look at the notes. "), ...toolUseBlock(1, "toolu_golden_1", "read_file", { path: "notes.txt" })],
    "tool_use",
  ),
  // Turn 1, round 2: final answer.
  scriptedTurn([...textBlock(0, GOLDEN_FINAL)], "end_turn"),
  // Turn 2 (permission), round 1: announce, then write a new file.
  scriptedTurn(
    [
      ...textBlock(0, "I will create the file. "),
      ...toolUseBlock(1, "toolu_perm_1", "write_file", { path: "out.txt", content: "line one\nline two\n" }),
    ],
    "tool_use",
  ),
  // Turn 2, round 2: done.
  scriptedTurn([...textBlock(0, PERM_FINAL)], "end_turn"),
];

function startMock(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const script = scripts[messageRequests] ?? scripts[scripts.length - 1];
    messageRequests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const [event, data] of script) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function postJson(pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${pathname}`,
      { method: "POST", headers: { "content-type": "application/json", "x-agent-token": backend.gui.token } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : undefined }));
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

type Frame = { event: string; data: any };

function subscribe() {
  const frames: Frame[] = [];
  let waiters: Array<{ event: string; resolve: (data: any) => void }> = [];
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  const req = http.get(`${base}/api/events?token=${backend.gui.token}`, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk: string) => {
      markReady();
      buf += chunk;
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        if (!event) continue;
        const raw = /^data: (.+)$/m.exec(block)?.[1];
        const data = raw ? JSON.parse(raw) : undefined;
        frames.push({ event, data });
        const hits = waiters.filter((w) => w.event === event);
        waiters = waiters.filter((w) => w.event !== event);
        for (const w of hits) w.resolve(data);
      }
    });
  });
  req.on("error", () => {});

  return {
    frames,
    ready,
    waitFor(event: string, ms = 15_000): Promise<any> {
      const hit = frames.find((f) => f.event === event);
      if (hit) return Promise.resolve(hit.data);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for "${event}"; saw ${frames.map((f) => f.event).join(",") || "nothing"}`)),
          ms,
        );
        waiters.push({
          event,
          resolve: (data) => {
            clearTimeout(timer);
            resolve(data);
          },
        });
      });
    },
    close() {
      req.destroy();
    },
  };
}

/** Replace values that legitimately differ between runs with stable tokens. */
function normalizeFrame(frame: Frame): Frame {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      let s = value.split(project).join("<PROJECT>").split(home).join("<HOME>");
      s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>");
      return s;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return { event: frame.event, data: walk(frame.data) };
}

/** Frames of one turn: from the first turn_start through its turn_end/turn_error. */
function turnFrames(sub: ReturnType<typeof subscribe>): Frame[] {
  const relevant = sub.frames.filter((f) => TURN_EVENTS.has(f.event));
  const start = relevant.findIndex((f) => f.event === "turn_start");
  const lastEnd = relevant.map((f) => f.event).lastIndexOf("turn_end");
  return relevant.slice(start, lastEnd + 1).map(normalizeFrame);
}

async function compareOrCapture(name: string, frames: Frame[]) {
  const lines = frames.map((f) => JSON.stringify(f));
  const file = path.join(FIXTURE_DIR, `${name}.jsonl`);
  if (CAPTURE) {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await fs.writeFile(file, lines.join("\n") + "\n");
    console.log(`[sse-replay] wrote ${lines.length} frames to ${path.relative(process.cwd(), file)}`);
    return;
  }
  let expected: string[];
  try {
    expected = (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    throw new Error(`missing fixture ${file} — run with AGENT_SSE_CAPTURE=1 to generate it`);
  }
  expect(lines, `SSE contract drift in ${name}.jsonl (regenerate with AGENT_SSE_CAPTURE=1)`).toEqual(expected);
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-sse-replay-"));
  project = path.join(home, "project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "notes.txt"), NOTES_BODY);

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.AGENT_PROVIDER = "anthropic";
  process.env.AGENT_MODEL = "claude-sonnet-4-5";
  delete process.env.AGENT_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;

  mock = await startMock();
  const port = (mock.address() as { port: number }).port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

  const { startGuiBackend } = await import("../src/gui/backend.js");
  backend = await startGuiBackend({ cwd: project, port: 0, noMcp: true, noLsp: true, noCron: true, onQuit: () => {} });
  base = `http://127.0.0.1:${backend.gui.port}`;
});

afterAll(async () => {
  await backend?.shutdown().catch(() => {});
  await new Promise<void>((resolve) => (mock ? mock.close(() => resolve()) : resolve()));
  try {
    const { flushUsage } = await import("../src/usage.js");
    await flushUsage();
  } catch {
    /* best effort */
  }
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
});

describe("SSE capture (real backend, contract drift)", () => {
  it("golden tool turn matches the checked-in fixture", async () => {
    const sub = subscribe();
    await sub.ready;
    expect((await postJson("/api/chat", { text: GOLDEN_PROMPT })).status).toBe(202);
    const end = await sub.waitFor("turn_end");
    expect(end.text).toContain(GOLDEN_FINAL);
    expect(sub.frames.some((f) => f.event === "turn_error")).toBe(false);

    const frames = turnFrames(sub);
    sub.close();
    expect(frames[0].event).toBe("turn_start");
    expect(frames[frames.length - 1].event).toBe("turn_end");
    for (const e of ["round_start", "text_delta", "tool_use_start", "tool_start", "tool_end", "usage"]) {
      expect(frames.map((f) => f.event)).toContain(e);
    }
    await compareOrCapture("golden-turn", frames);
  });

  it("permission turn carries the diff preview and matches the fixture", async () => {
    const sub = subscribe();
    await sub.ready;
    expect((await postJson("/api/chat", { text: PERM_PROMPT })).status).toBe(202);
    const ask = await sub.waitFor("permission_request");
    expect(ask.risk).toBe("high");
    expect(ask.description).toContain("Create file out.txt");
    expect(ask.preview).toContain("+line one");
    expect((await postJson("/api/permission", { id: ask.id, decision: "yes" })).status).toBe(200);
    const end = await sub.waitFor("turn_end");
    expect(end.text).toContain(PERM_FINAL);

    const frames = turnFrames(sub);
    sub.close();
    expect(frames[0].event).toBe("turn_start");
    expect(frames[frames.length - 1].event).toBe("turn_end");
    for (const e of ["round_start", "text_delta", "tool_use_start", "tool_start", "permission_request", "tool_end", "usage"]) {
      expect(frames.map((f) => f.event)).toContain(e);
    }
    await compareOrCapture("permission-diff", frames);
  });
});

/* ---------------- Part 2: happy-dom replay ---------------- */

const html = readFileSync(path.join(process.cwd(), "src/gui/static/index.html"), "utf8");
const appJs = readFileSync(path.join(process.cwd(), "src/gui/static/app.js"), "utf8");
const bodyHtml = html
  .slice(html.indexOf("<body>") + "<body>".length, html.indexOf("</body>"))
  .replace(/<script[\s\S]*?<\/script>/g, "");

type Listener = (event: { data: string }) => void;

class ReplayEventSource {
  static instances: ReplayEventSource[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor() {
    ReplayEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: Listener) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  emit(name: string, data: unknown) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) });
  }
  close() {}
}

async function loadFixture(name: string): Promise<Frame[]> {
  const raw = await fs.readFile(path.join(FIXTURE_DIR, `${name}.jsonl`), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Frame);
}

async function bootReplayer() {
  const window = new Window({ url: "http://127.0.0.1:4611/#replay-token", width: 1280, height: 900 });
  ReplayEventSource.instances.length = 0;
  window.document.body.innerHTML = bodyHtml;

  const w = window as unknown as Record<string, unknown> & Window;
  w.marked = { parse: (text: string) => `<p>${text}</p>`, setOptions: () => {} };
  w.DOMPurify = { sanitize: (value: string) => value };

  const state = {
    busy: false,
    planMode: false,
    mode: "default",
    cwd: "D:\\proj",
    sessionId: "abcd1234",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    api: { baseURL: "", hasKey: true },
    hasKey: true,
    customCommands: [],
    transcript: [],
    liveTurn: null,
    pendingPermissions: [],
    tokenEstimate: 1200,
    contextWindow: 200_000,
    cost: "$0.00",
    todos: [],
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/api/permission") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url === "/api/sessions" || url === "/api/models") return { ok: true, status: 200, json: async () => [] };
    if (url === "/api/background") return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
    return { ok: true, status: 200, json: async () => state };
  };
  w.EventSource = ReplayEventSource;
  w.setInterval = () => 0;
  window.eval(appJs);
  await vi.waitFor(() => expect(window.document.querySelectorAll("#model-select option").length).toBeGreaterThan(0), {
    timeout: 3000,
  });
  return { window, calls, state, source: ReplayEventSource.instances[0] };
}

describe("SSE replay into the GUI (happy-dom)", () => {
  it("replays the golden turn: streaming text, tool card lifecycle, completion", async () => {
    const { window, state, source } = await bootReplayer();
    const doc = window.document;
    const frames = await loadFixture("golden-turn");
    const cut = frames.findIndex((f) => f.event === "turn_end");

    // Mid-turn: the live transcript streams text and resolves the tool card.
    // Text rendering goes through requestAnimationFrame, so poll.
    for (const frame of frames.slice(0, cut)) source.emit(frame.event, frame.data);
    await vi.waitFor(() => {
      expect(doc.querySelector("#transcript")?.textContent).toContain("Let me look at the notes.");
      expect(doc.querySelector("#transcript")?.textContent).toContain(NOTES_BODY.trim());
    });
    expect(doc.querySelector("#transcript .tool-status")?.className).toContain("ok");

    // turn_end makes the app resync from /api/state; mirror the real server's
    // history rebuild so the redraw keeps the finished turn.
    state.transcript = [
      { kind: "user", text: GOLDEN_PROMPT },
      { kind: "tool", tool: { id: "toolu_golden_1", name: "read_file", round: 1, input: { path: "notes.txt" }, result: NOTES_BODY, ok: true } },
      { kind: "assistant", text: GOLDEN_FINAL },
    ];
    source.emit("turn_end", frames[cut].data);
    await vi.waitFor(() => expect(doc.querySelector("#transcript")?.textContent).toContain(GOLDEN_FINAL));
    expect(doc.querySelector("#transcript")?.textContent).toContain("✓");
    expect(doc.querySelector("#perm-modal")?.classList.contains("hidden")).toBe(true);
    await vi.waitFor(() => expect(doc.querySelector("#input")?.hasAttribute("disabled")).toBe(false));
    (window as unknown as { happyDOM: { close(): Promise<void> } }).happyDOM.close();
  });

  it("replays the permission turn: modal with diff, approve POST, completion", async () => {
    const { window, calls, state, source } = await bootReplayer();
    const doc = window.document;
    const frames = await loadFixture("permission-diff");
    const cut = frames.findIndex((f) => f.event === "permission_request");

    for (const frame of frames.slice(0, cut + 1)) source.emit(frame.event, frame.data);
    expect(doc.querySelector("#perm-modal")?.classList.contains("hidden")).toBe(false);
    expect(doc.querySelector("#perm-risk")?.textContent).toContain("高危");
    expect(doc.querySelector("#perm-desc")?.textContent).toContain("Create file out.txt");
    expect(doc.querySelector("#perm-preview")?.textContent).toContain("+line one");
    expect(doc.querySelector("#perm-preview")?.textContent).toContain("+line two");

    (doc.querySelector('.perm-actions button[data-decision="yes"]') as HTMLElement).click();
    await vi.waitFor(() => expect(calls.some((c) => c.url === "/api/permission")).toBe(true));
    const perm = calls.find((c) => c.url === "/api/permission")!;
    expect(JSON.parse(String(perm.init?.body))).toEqual({ id: expect.any(String), decision: "yes" });

    state.transcript = [
      { kind: "user", text: PERM_PROMPT },
      { kind: "tool", tool: { id: "toolu_perm_1", name: "write_file", round: 1, input: { path: "out.txt" }, result: "Created out.txt (20 chars)", ok: true } },
      { kind: "assistant", text: PERM_FINAL },
    ];
    const end = frames.findIndex((f) => f.event === "turn_end");
    for (const frame of frames.slice(cut + 1, end)) source.emit(frame.event, frame.data);
    source.emit("turn_end", frames[end].data);
    await vi.waitFor(() => expect(doc.querySelector("#transcript")?.textContent).toContain(PERM_FINAL));
    expect(doc.querySelector("#perm-modal")?.classList.contains("hidden")).toBe(true);
    await vi.waitFor(() => expect(doc.querySelector("#input")?.hasAttribute("disabled")).toBe(false));
    (window as unknown as { happyDOM: { close(): Promise<void> } }).happyDOM.close();
  });
});
