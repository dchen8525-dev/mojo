import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM } from "../src/llm.js";
import { clearModelMeta, setModelMeta } from "../src/modelMeta.js";

const common = { cwd: process.cwd(), apiKey: "sk-test" };

beforeEach(() => clearModelMeta());
afterEach(() => vi.unstubAllGlobals());

describe("LLM.contextWindow precedence", () => {
  it("explicit config wins over endpoint metadata and the static table", () => {
    setModelMeta("anthropic", "https://gw.example", "claude-sonnet-4-5", { contextWindow: 500_000 });
    const llm = new LLM({
      ...common,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      baseURL: "https://gw.example",
      contextWindow: 42,
    });
    expect(llm.contextWindow).toBe(42);
  });

  it("endpoint metadata beats the static table", () => {
    setModelMeta("anthropic", "https://gw.example", "claude-sonnet-4-5", { contextWindow: 500_000 });
    const llm = new LLM({
      ...common,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      baseURL: "https://gw.example",
    });
    expect(llm.contextWindow).toBe(500_000);
  });

  it("falls back to the static table when nothing else is known", () => {
    const llm = new LLM({
      ...common,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      baseURL: "https://unknown.example",
    });
    expect(llm.contextWindow).toBe(200_000);
  });

  it("refreshModelMeta caches the endpoint value and skips repeat requests", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-sonnet-4-5", context_window: 777 }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const llm = new LLM({
      ...common,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      baseURL: "https://gw.example",
    });
    expect(llm.contextWindow).toBe(200_000);

    await llm.refreshModelMeta();
    expect(llm.contextWindow).toBe(777);

    const calls = fetchMock.mock.calls.length;
    await llm.refreshModelMeta();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
