import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageParam } from "../src/types.js";
import type { StreamEvents } from "../src/llm/types.js";
import { StreamInterrupted } from "../src/llm/types.js";

// Scripted backends so no network or API key is involved.
const h = vi.hoisted(() => {
  const script: Array<(signal?: AbortSignal, events?: StreamEvents) => unknown> = [];
  function backend(provider: string) {
    return class {
      readonly provider = provider;
      model = "test-model";
      async send(
        _messages: MessageParam[],
        _system: unknown,
        _tools: unknown,
        signal?: AbortSignal,
        events?: StreamEvents,
      ) {
        const next = script.shift();
        if (!next) throw new Error("unexpected backend call");
        return await next(signal, events);
      }
      async listModels() {
        return [];
      }
    };
  }
  return { script, backend };
});

vi.mock("../src/llm/anthropic.js", () => ({ AnthropicBackend: h.backend("anthropic") }));
vi.mock("../src/llm/openai.js", () => ({ OpenAiBackend: h.backend("openai") }));

const { LLM } = await import("../src/llm.js");
const { CancelledStreamError } = await import("../src/llm/types.js");

function makeLLM(provider: "anthropic" | "openai" = "anthropic") {
  return new LLM({
    provider,
    model: "test-model",
    apiKey: "sk-test",
    cwd: path.join(os.tmpdir(), "mojo-cancel-cwd"),
    home: path.join(os.tmpdir(), "mojo-cancel-home"),
  });
}

afterEach(() => {
  h.script.length = 0;
});

describe("cancelled-stream salvage", () => {
  it("carries the streamed-so-far text when the user aborts mid-stream", async () => {
    const ac = new AbortController();
    h.script.push(async (_signal, events) => {
      events?.onTextDelta?.("hello partial ");
      ac.abort();
      throw new Error("Request was aborted.");
    });
    await expect(makeLLM().send([{ role: "user", content: "hi" }], "sys", [], ac.signal, { onTextDelta: () => {} })).rejects.toThrow("aborted");
    // Rethrow the promise to inspect the error object itself.
    const ac2 = new AbortController();
    h.script.push(async (_signal, events) => {
      events?.onTextDelta?.("hello partial ");
      ac2.abort();
      throw new Error("Request was aborted.");
    });
    const err = await makeLLM()
      .send([{ role: "user", content: "hi" }], "sys", [], ac2.signal, { onTextDelta: () => {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelledStreamError);
    expect((err as CancelledStreamError).partialText).toBe("hello partial ");
  });

  it("carries an empty partial when nothing had streamed yet", async () => {
    const ac = new AbortController();
    h.script.push(async (_signal) => {
      ac.abort();
      throw new Error("Request was aborted.");
    });
    const err = await makeLLM()
      .send([{ role: "user", content: "hi" }], "sys", [], ac.signal, { onTextDelta: () => {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelledStreamError);
    expect((err as CancelledStreamError).partialText).toBe("");
  });

  it("aborts during an anthropic resume keep prefill + held-back suffix", async () => {
    const ac = new AbortController();
    h.script.push(async () => {
      throw new StreamInterrupted("part one ");
    });
    h.script.push(async (_signal, events) => {
      events?.onTextDelta?.("part two");
      ac.abort();
      throw new Error("Request was aborted.");
    });
    const err = await makeLLM("anthropic")
      .send([{ role: "user", content: "hi" }], "sys", [], ac.signal, { onTextDelta: () => {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelledStreamError);
    expect((err as CancelledStreamError).partialText).toBe("part one part two");
  });
});
