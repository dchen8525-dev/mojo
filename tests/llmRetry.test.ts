import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageParam } from "../src/types.js";
import type { RetryInfo, StreamEvents } from "../src/llm/types.js";
import { StreamInterrupted } from "../src/llm/types.js";

// The facade is what retries; swap both backends for a scripted one so no
// network or API key is involved.
const h = vi.hoisted(() => {
  const calls: Array<{ messages: MessageParam[]; signal?: AbortSignal; events?: StreamEvents }> = [];
  const script: Array<() => unknown> = [];
  function backend(provider: string) {
    return class {
      readonly provider = provider;
      model = "test-model";
      async send(
        messages: MessageParam[],
        _system: string,
        _tools: unknown,
        signal?: AbortSignal,
        events?: StreamEvents,
      ) {
        calls.push({ messages, signal, events });
        const next = script.shift();
        if (!next) throw new Error("unexpected backend call");
        return await next();
      }
      async listModels() {
        return [];
      }
    };
  }
  return { calls, script, backend };
});

vi.mock("../src/llm/anthropic.js", () => ({ AnthropicBackend: h.backend("anthropic") }));
vi.mock("../src/llm/openai.js", () => ({ OpenAiBackend: h.backend("openai") }));

const { LLM } = await import("../src/llm.js");

const messages: MessageParam[] = [{ role: "user", content: "hi" }];

/** Replace the script in place: the mocked backend holds a reference to the array. */
function setScript(...entries: Array<() => unknown>) {
  h.script.length = 0;
  h.script.push(...entries);
}

function makeLLM(provider: "anthropic" | "openai" = "anthropic") {
  return new LLM({
    provider,
    model: "test-model",
    apiKey: "sk-test",
    cwd: path.join(os.tmpdir(), "mojo-retry-cwd"),
    home: path.join(os.tmpdir(), "mojo-retry-home"),
  });
}

function turn(text: string) {
  return {
    text,
    toolUses: [],
    content: [{ type: "text", text }],
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    stopReason: "end_turn",
  };
}

function httpError(status: number, retryAfter?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    headers: { get: (key: string) => (key.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
  });
}

function connectionError() {
  return Object.assign(new Error("Connection error."), { name: "APIConnectionError" });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.calls.length = 0;
  h.script.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LLM retry and stream resume", () => {
  it("honors Retry-After on a 429", async () => {
    setScript(
      () => { throw httpError(429, "2"); },
      () => turn("ok"),
    );
    const p = makeLLM().send(messages, "S", []);

    await vi.advanceTimersByTimeAsync(1999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ text: "ok" });
    expect(h.calls).toHaveLength(2);
  });

  it("retries a request timeout and a gateway timeout", async () => {
    setScript(
      () => { throw Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" }); },
      () => { throw httpError(504); },
      () => turn("ok"),
    );
    const p = makeLLM().send(messages, "S", []);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toMatchObject({ text: "ok" });
    expect(h.calls).toHaveLength(3);
  });

  it("retries a 408 request timeout", async () => {
    setScript(
      () => { throw httpError(408); },
      () => turn("ok"),
    );
    const p = makeLLM().send(messages, "S", []);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ text: "ok" });
  });

  it("accepts an HTTP-date Retry-After", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const when = new Date(Date.now() + 4000).toUTCString();
    setScript(
      () => { throw httpError(429, when); },
      () => turn("ok"),
    );
    const p = makeLLM().send(messages, "S", []);

    await vi.advanceTimersByTimeAsync(3999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ text: "ok" });
  });

  it("caps Retry-After at 30 seconds", async () => {
    setScript(
      () => { throw httpError(429, "60"); },
      () => turn("ok"),
    );
    const p = makeLLM().send(messages, "S", []);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ text: "ok" });
  });

  it("backs off for connection failures", async () => {
    setScript(
      () => { throw connectionError(); },
      () => turn("ok"),
    );
    const p = makeLLM().send(messages, "S", []);

    await vi.advanceTimersByTimeAsync(999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ text: "ok" });
  });

  it("reports each retry, including the server-requested delay", async () => {
    setScript(
      () => { throw httpError(429, "2"); },
      () => turn("ok"),
    );
    const seen: RetryInfo[] = [];
    const p = makeLLM().send(messages, "S", [], undefined, { onRetry: (info) => seen.push(info) });

    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ attempt: 1, maxAttempts: 3, delayMs: 2000, status: 429, reason: "rate-limit" }]);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toMatchObject({ text: "ok" });
    expect(seen).toHaveLength(1);
  });

  it("labels connection failures and stays silent for non-retriable errors", async () => {
    setScript(
      () => { throw connectionError(); },
      () => { throw httpError(400); },
    );
    const seen: RetryInfo[] = [];
    const p = makeLLM().send(messages, "S", [], undefined, { onRetry: (info) => seen.push(info) })
      .catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ status: 400 });
    expect(seen).toEqual([{ attempt: 1, maxAttempts: 3, delayMs: 1000, reason: "connection" }]);
  });

  it("gives up after three retries", async () => {
    setScript(...Array.from({ length: 4 }, () => () => { throw httpError(503); }));
    const p = makeLLM().send(messages, "S", []).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(11_000);
    await expect(p).resolves.toMatchObject({ status: 503 });
    expect(h.calls).toHaveLength(4);
  });

  it("does not retry client errors", async () => {
    setScript(() => { throw httpError(400); });
    await expect(makeLLM().send(messages, "S", [])).rejects.toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(1);
  });

  it("does not retry arbitrary programming errors", async () => {
    setScript(() => { throw new Error("boom"); });
    await expect(makeLLM().send(messages, "S", [])).rejects.toThrow("boom");
    expect(h.calls).toHaveLength(1);
  });

  it("wakes up immediately when aborted during backoff", async () => {
    setScript(
      () => { throw httpError(500); },
      () => turn("never"),
    );
    const controller = new AbortController();
    const p = makeLLM().send(messages, "S", [], controller.signal).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);
    controller.abort();
    await expect(p).resolves.toMatchObject({ status: 500 });
    expect(h.calls).toHaveLength(1);
  });

  it("resumes an Anthropic stream with assistant prefill and dedupes the overlap", async () => {
    setScript(
      () => { throw new StreamInterrupted("Hello"); },
      () => turn("Hello world"),
    );
    const result = await makeLLM("anthropic").send(messages, "S", []);

    expect(result.text).toBe("Hello world");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    });
  });

  it("asks an OpenAI model to continue from the cut-off point", async () => {
    setScript(
      () => { throw new StreamInterrupted("abc"); },
      () => turn("abc def"),
    );
    const result = await makeLLM("openai").send(messages, "S", []);

    expect(result.text).toBe("abc def");
    expect(h.calls).toHaveLength(2);
    const last = h.calls[1].messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("cut off mid-stream");
    expect(String(last.content)).toContain("abc");
  });

  it("stops after two resumes and reports the received text", async () => {
    setScript(
      () => { throw new StreamInterrupted("aa"); },
      () => { throw new StreamInterrupted("bb"); },
      () => { throw new StreamInterrupted("cc"); },
    );

    await expect(makeLLM().send(messages, "S", [])).rejects.toThrow(/stream interrupted; 4 chars/);
    expect(h.calls).toHaveLength(3);
  });
});
