import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageParam } from "../src/types.js";
import type { RetryInfo, StreamEvents } from "../src/llm/types.js";
import { CancelledStreamError, StreamInterrupted, StreamRecoveryExhausted } from "../src/llm/types.js";

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

const { LLM, isContextOverflowError } = await import("../src/llm.js");

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

/** SDK 0.135 stopped setting `name` on APIConnectionError. */
function sdkConnectionError() {
  const err = new Error("Connection error.");
  Object.defineProperty(err, "name", { value: "Error" });
  Object.defineProperty(err, "constructor", { value: { name: "APIConnectionError" } });
  return err;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Deterministic backoff: jitter would randomize the waits these tests assert.
  process.env.AGENT_RETRY_JITTER = "0";
  h.calls.length = 0;
  h.script.length = 0;
});

afterEach(() => {
  delete process.env.AGENT_RETRY_JITTER;
  delete process.env.AGENT_RETRY_BASE_MS;
  delete process.env.AGENT_RETRY_MAX_ATTEMPTS;
  delete process.env.AGENT_STREAM_RECOVERY_ATTEMPTS;
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
    await vi.advanceTimersByTimeAsync(2000);
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

  it("backs off for connection failures that only identify via the constructor", async () => {
    setScript(
      () => { throw sdkConnectionError(); },
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

  it("backs off exponentially: 1s, 2s, 4s", async () => {
    setScript(
      () => { throw httpError(503); },
      () => { throw httpError(503); },
      () => { throw httpError(503); },
      () => turn("ok"),
    );
    const seen: RetryInfo[] = [];
    const p = makeLLM().send(messages, "S", [], undefined, { onRetry: (info) => seen.push(info) });

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(p).resolves.toMatchObject({ text: "ok" });
    expect(seen.map((r) => r.delayMs)).toEqual([1000, 2000, 4000]);
  });

  it("caps the backoff at AGENT_RETRY_MAX_DELAY_MS", async () => {
    process.env.AGENT_RETRY_BASE_MS = "30000";
    process.env.AGENT_RETRY_MAX_DELAY_MS = "45000";
    setScript(
      () => { throw httpError(503); },
      () => { throw httpError(503); },
      () => turn("ok"),
    );
    const seen: RetryInfo[] = [];
    const p = makeLLM().send(messages, "S", [], undefined, { onRetry: (info) => seen.push(info) });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(p).resolves.toMatchObject({ text: "ok" });
    // 30s * 2 = 60s would exceed the cap, so the second wait is clamped.
    expect(seen.map((r) => r.delayMs)).toEqual([30_000, 45_000]);
  });

  it("takes AGENT_RETRY_MAX_ATTEMPTS into account", async () => {
    process.env.AGENT_RETRY_MAX_ATTEMPTS = "1";
    setScript(
      () => { throw httpError(503); },
      () => { throw httpError(503); },
    );
    const p = makeLLM().send(messages, "S", []).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toMatchObject({ status: 503 });
    expect(h.calls).toHaveLength(2);
  });

  it("retries a stalled stream and labels it a timeout", async () => {
    setScript(
      () => { throw Object.assign(new Error("stream idle for 60s"), { name: "StreamIdleError" }); },
      () => turn("ok"),
    );
    const seen: RetryInfo[] = [];
    const p = makeLLM().send(messages, "S", [], undefined, { onRetry: (info) => seen.push(info) });

    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ text: "ok" });
    expect(seen).toEqual([{ attempt: 1, maxAttempts: 3, delayMs: 1000, reason: "timeout" }]);
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

  it("rewrites duplicate tool ids returned by a gateway", async () => {
    setScript(() => ({
      ...turn(""),
      toolUses: [
        { type: "tool_use", id: "dup", name: "read_file", input: { path: "a" } },
        { type: "tool_use", id: "dup", name: "read_file", input: { path: "b" } },
        { type: "tool_use", id: "", name: "glob_files", input: { pattern: "*" } },
      ],
      content: [],
    }));
    const result = await makeLLM("openai").send(messages, "S", []);
    const ids = result.toolUses.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe("dup_2");
  });

  it("wakes up immediately when aborted during backoff and reports an abort", async () => {
    setScript(
      () => { throw httpError(500); },
      () => turn("never"),
    );
    const controller = new AbortController();
    const p = makeLLM().send(messages, "S", [], controller.signal).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);
    controller.abort();
    await expect(p).resolves.toMatchObject({ message: "aborted" });
    expect(h.calls).toHaveLength(1);
  });

  it("normalizes a backend abort to the same message", async () => {
    setScript(() => {
      throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
    });
    const controller = new AbortController();
    controller.abort(); // aborted before the call, like a cancelled stream

    await expect(
      makeLLM().send(messages, "S", [], controller.signal),
    ).rejects.toThrow("aborted");
  });

  it("resumes an Anthropic stream with assistant prefill and dedupes the overlap", async () => {
    setScript(
      () => { throw new StreamInterrupted("Hello"); },
      () => turn("Hello world"),
    );
    const p = makeLLM("anthropic").send(messages, "S", []);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result.text).toBe("Hello world");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    });
  });

  it("emits only the new suffix when a resumed stream repeats the overlap", async () => {
    setScript(
      () => {
        h.calls.at(-1)!.events?.onTextDelta?.("Hello");
        throw new StreamInterrupted("Hello");
      },
      () => {
        h.calls.at(-1)!.events?.onTextDelta?.("Hello world");
        return turn("Hello world");
      },
    );
    const deltas: string[] = [];
    const p = makeLLM("openai").send(messages, "S", [], undefined, {
      onTextDelta: (delta) => deltas.push(delta),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result.text).toBe("Hello world");
    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("asks an OpenAI model to continue from the cut-off point", async () => {
    setScript(
      () => { throw new StreamInterrupted("abc"); },
      () => turn("abc def"),
    );
    const p = makeLLM("openai").send(messages, "S", []);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result.text).toBe("abc def");
    expect(h.calls).toHaveLength(2);
    const last = h.calls[1].messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("cut off mid-stream");
    expect(String(last.content)).toContain("abc");
  });

  it("reports a resume recovery with its backoff", async () => {
    setScript(
      () => { throw new StreamInterrupted("abc"); },
      () => turn("abcdef"),
    );
    const seen: Array<Record<string, unknown>> = [];
    const p = makeLLM().send(messages, "S", [], undefined, {
      onStreamRecovery: (info) => seen.push(info),
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ text: "abcdef" });
    expect(seen).toEqual([
      { attempt: 1, maxAttempts: 4, mode: "resume", discardedChars: 0, delayMs: 1000, reason: "stream" },
    ]);
  });

  it("restarts from the original messages when a tool call was streaming", async () => {
    setScript(
      () => {
        h.calls.at(-1)!.events?.onTextDelta?.("intro");
        throw new StreamInterrupted("intro", undefined, { toolStarted: true });
      },
      () => {
        h.calls.at(-1)!.events?.onTextDelta?.("second try");
        return turn("second try");
      },
    );
    const deltas: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    const p = makeLLM("anthropic").send(messages, "S", [], undefined, {
      onTextDelta: (delta) => deltas.push(delta),
      onStreamRecovery: (info) => seen.push(info),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result.text).toBe("second try");
    expect(deltas).toEqual(["intro", "second try"]);
    // No prefill: the re-run starts from the untouched history.
    expect(h.calls[1].messages).toHaveLength(1);
    expect(seen).toEqual([
      { attempt: 1, maxAttempts: 4, mode: "restart", discardedChars: 5, delayMs: 1000, reason: "stream" },
    ]);
  });

  it("keeps the text from an interrupted resume in sync with the host", async () => {
    setScript(
      () => { throw new StreamInterrupted("hello "); },
      () => {
        h.calls.at(-1)!.events?.onTextDelta?.("wor");
        throw new StreamInterrupted("wor");
      },
      () => turn("hello world"),
    );
    const deltas: string[] = [];
    const p = makeLLM().send(messages, "S", [], undefined, {
      onTextDelta: (delta) => deltas.push(delta),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toMatchObject({ text: "hello world" });
    // The held-back continuation from the failed resume reaches the UI too.
    expect(deltas).toEqual(["hello ", "wor", "ld"]);
  });

  it("does not recover a non-transient break", async () => {
    setScript(() => { throw new StreamInterrupted("abc", httpError(400)); });
    const err = await makeLLM().send(messages, "S", []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamRecoveryExhausted);
    expect((err as InstanceType<typeof StreamRecoveryExhausted>).partialText).toBe("abc");
    expect((err as Error).message).toMatch(/stream interrupted; 3 chars/);
    expect(h.calls).toHaveLength(1);
  });

  it("recovers a break whose cause is transient", async () => {
    setScript(
      () => { throw new StreamInterrupted("abc", httpError(503)); },
      () => turn("abcdef"),
    );
    const seen: Array<Record<string, unknown>> = [];
    const p = makeLLM().send(messages, "S", [], undefined, {
      onStreamRecovery: (info) => seen.push(info),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ text: "abcdef" });
    expect(seen[0].reason).toBe("server");
  });

  it("stops after the recovery budget and reports the received text", async () => {
    process.env.AGENT_STREAM_RECOVERY_ATTEMPTS = "2";
    setScript(
      () => { throw new StreamInterrupted("aa"); },
      () => { throw new StreamInterrupted("bb"); },
      () => { throw new StreamInterrupted("cc"); },
    );

    const p = makeLLM().send(messages, "S", []).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const err = await p;
    expect(err).toBeInstanceOf(StreamRecoveryExhausted);
    expect((err as Error).message).toMatch(/stream interrupted; 6 chars/);
    expect((err as InstanceType<typeof StreamRecoveryExhausted>).partialText).toBe("aabbcc");
    expect(h.calls).toHaveLength(3);
  });

  it("can disable stream recovery entirely", async () => {
    process.env.AGENT_STREAM_RECOVERY_ATTEMPTS = "0";
    setScript(() => { throw new StreamInterrupted("abc"); });
    await expect(makeLLM().send(messages, "S", [])).rejects.toBeInstanceOf(StreamRecoveryExhausted);
    expect(h.calls).toHaveLength(1);
  });

  it("wakes up immediately when aborted during a recovery backoff", async () => {
    setScript(() => { throw new StreamInterrupted("abc"); });
    const controller = new AbortController();
    const p = makeLLM().send(messages, "S", [], controller.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const err = await p;
    expect(err).toBeInstanceOf(CancelledStreamError);
    expect((err as InstanceType<typeof CancelledStreamError>).partialText).toBe("abc");
    expect(h.calls).toHaveLength(1);
  });
});

describe("isContextOverflowError", () => {
  it("recognizes context-overflow wording across providers", () => {
    expect(
      isContextOverflowError({
        status: 400,
        message: "prompt is too long: 213456 tokens > 200000 maximum",
      }),
    ).toBe(true);
    expect(
      isContextOverflowError({
        status: 400,
        message: "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens.",
      }),
    ).toBe(true);
    expect(
      isContextOverflowError({
        status: 400,
        error: { code: "context_length_exceeded", message: "Please reduce the length of the messages." },
      }),
    ).toBe(true);
    expect(
      isContextOverflowError({
        status: 400,
        message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
      }),
    ).toBe(true);
    expect(isContextOverflowError({ status: 413, message: "Request too large" })).toBe(true);
  });

  it("does not claim ordinary 400s or transient failures", () => {
    expect(isContextOverflowError({ status: 400, message: "invalid tool schema" })).toBe(false);
    expect(isContextOverflowError({ status: 429, message: "prompt is too long" })).toBe(false);
    expect(isContextOverflowError({ status: 500, message: "context_length_exceeded" })).toBe(false);
    expect(isContextOverflowError(new Error("ECONNRESET"))).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });
});
