import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearModelMeta, fetchModelMeta, getModelMeta, setModelMeta } from "../src/modelMeta.js";

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  clearModelMeta();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchModelMeta", () => {
  it("reads the context window for a matching model id", async () => {
    const fetchMock = vi.fn(async () => jsonRes({ data: [{ id: "deepseek-flash", context_window: 1_048_576 }] }));
    vi.stubGlobal("fetch", fetchMock);

    const meta = await fetchModelMeta({ provider: "openai", model: "deepseek-flash", baseURL: "https://api.deepseek.com" });
    expect(meta).toEqual({ contextWindow: 1_048_576 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/models");
  });

  it("matches the id case-insensitively", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ data: [{ id: "GLM-4.6", context_length: 200_000 }] })));
    const meta = await fetchModelMeta({ provider: "openai", model: "glm-4.6", baseURL: "https://gw.example/v1" });
    expect(meta).toEqual({ contextWindow: 200_000 });
  });

  it("uses the only entry when no id matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ data: [{ id: "whatever", max_context_tokens: "32000" }] })));
    const meta = await fetchModelMeta({ provider: "openai", model: "my-model", baseURL: "https://gw.example/v1" });
    expect(meta).toEqual({ contextWindow: 32_000 });
  });

  it("returns null when the entry carries no window field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ data: [{ id: "m", owned_by: "x" }] })));
    expect(await fetchModelMeta({ provider: "openai", model: "m", baseURL: "https://gw.example/v1" })).toBeNull();
  });

  it("falls back to the host's OpenAI-style /models for an Anthropic endpoint", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        if (url.endsWith("/anthropic/v1/models")) return jsonRes({}, false, 404);
        return jsonRes({ data: [{ id: "deepseek-flash", context_window: 1_048_576 }] });
      }),
    );

    const meta = await fetchModelMeta({
      provider: "anthropic",
      model: "deepseek-flash",
      baseURL: "https://api.deepseek.com/anthropic",
      apiKey: "sk-x",
    });
    expect(meta).toEqual({ contextWindow: 1_048_576 });
    expect(seen).toEqual(["https://api.deepseek.com/anthropic/v1/models", "https://api.deepseek.com/models"]);
  });

  it("returns null when every request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await fetchModelMeta({ provider: "openai", model: "m", baseURL: "https://gw.example/v1" })).toBeNull();
  });
});

describe("model meta cache", () => {
  it("keys by provider + endpoint + model, ignoring trailing slashes", () => {
    setModelMeta("openai", "https://gw.example/v1/", "glm-4.6", { contextWindow: 1234 });
    expect(getModelMeta("openai", "https://gw.example/v1", "glm-4.6")).toEqual({ contextWindow: 1234 });
    expect(getModelMeta("openai", "https://other", "glm-4.6")).toBeUndefined();
    expect(getModelMeta("anthropic", "https://gw.example/v1", "glm-4.6")).toBeUndefined();
  });
});
