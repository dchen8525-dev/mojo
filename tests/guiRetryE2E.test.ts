import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningBackend } from "../src/gui/backend.js";

/**
 * End-to-end check through the real GUI server: a mock Anthropic endpoint
 * returns 429, the LLM facade backs off, and the turn's retry/finish events
 * must reach the client over the same SSE stream the browser uses. The unit
 * tests stub each layer; this one catches wiring drift between them.
 */

const FINAL_TEXT = "mock reply";
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
let failNext = false;
let retryAfterSecs = 1;

function startMock(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    messageRequests++;
    req.resume();
    req.on("end", () => {
      if (failNext) {
        failNext = false;
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(retryAfterSecs) });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
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
      });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: FINAL_TEXT },
      });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function postJson(pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${pathname}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-token": backend.gui.token },
      },
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
        if (!event) continue; // ": hello" / keep-alive comments
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

let openStreams: Array<ReturnType<typeof subscribe>> = [];

function openStream() {
  const sub = subscribe();
  openStreams.push(sub);
  return sub;
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-retry-e2e-"));
  project = path.join(home, "project");
  await fs.mkdir(project);

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
  backend = await startGuiBackend({ cwd: project, port: 0, noMcp: true, noLsp: true, onQuit: () => {} });
  base = `http://127.0.0.1:${backend.gui.port}`;
});

afterAll(async () => {
  for (const sub of openStreams) sub.close();
  openStreams = [];
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

describe("GUI retry path (real HTTP/SSE)", () => {
  it("reports Retry-After backoff, then completes the turn", async () => {
    const sub = openStream();
    await sub.ready;
    failNext = true;
    retryAfterSecs = 1;
    const before = messageRequests;

    const chat = await postJson("/api/chat", { text: "hello" });
    expect(chat.status).toBe(202);

    const retry = await sub.waitFor("retry");
    expect(retry).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      status: 429,
      reason: "rate-limit",
    });

    const end = await sub.waitFor("turn_end");
    expect(end.text).toBe(FINAL_TEXT);
    expect(messageRequests - before).toBe(2);
    expect(sub.frames.some((f) => f.event === "turn_error")).toBe(false);
    expect(sub.frames.map((f) => f.event)).toContain("text_delta");
    sub.close();
  });

  it("reports an abort during backoff as an aborted turn, not a transient error", async () => {
    const sub = openStream();
    await sub.ready;
    failNext = true;
    retryAfterSecs = 2;
    const before = messageRequests;

    expect((await postJson("/api/chat", { text: "cancel me" })).status).toBe(202);
    const retry = await sub.waitFor("retry");
    expect(retry).toMatchObject({ delayMs: 2000, status: 429 });

    const abort = await postJson("/api/abort");
    expect(abort.status).toBe(200);

    const err = await sub.waitFor("turn_error");
    expect(err).toMatchObject({ aborted: true, message: "" });
    expect(messageRequests - before).toBe(1);
    sub.close();
  });
});
