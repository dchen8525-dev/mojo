import { describe, expect, it } from "vitest";
import http from "node:http";
import type { Agent } from "../src/agent.js";
import type { PermissionManager } from "../src/permissions.js";
import { SseHub } from "../src/gui/sse.js";
import { GuiRuntime } from "../src/gui/state.js";
import { startGuiServer, type RunningGui } from "../src/gui/server.js";
import type { SwitchResult } from "../src/gui/project.js";
import type { ProfileInput, PublicProfile } from "../src/llmProfiles.js";

const TOKEN = "testtoken123";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    cwd: "/tmp/repo",
    sessionId: "sess1",
    provider: "anthropic",
    model: "glm-5.3-flash",
    contextWindow: 200_000,
    planMode: false,
    costs: { format: () => "$0.00 total" },
    tokenEstimate: () => 1000,
    currentTodos: () => [],
    getMessages: () => [],
    switchModel: (s: string) => ({ provider: "anthropic", model: s }),
    listModels: async () => ["m1"],
    chat: async () => "done",
    ...overrides,
  } as unknown as Agent;
}

function fakePermissions(): PermissionManager {
  return { mode: "default", getRules: () => [], clearRules: async () => ({ global: 0, project: 0 }), check: async () => true } as unknown as PermissionManager;
}

async function withServer(
  fn: (gui: RunningGui, runtime: GuiRuntime, agent: Agent) => Promise<void>,
  agentOverrides: Partial<Agent> = {},
  serverOverrides: Partial<{
    renameSession: (id: string, title: string) => Promise<boolean>;
    tagSession: (id: string, tags: string[]) => Promise<string[] | null>;
    deleteSession: (id: string) => Promise<{ ok: boolean; error?: string; activeReplaced?: string }>;
    searchSessions: (q: string, o?: { regex?: boolean }) => Promise<unknown[]>;
    switchProject: (cwd: string, opts?: { resumeId?: string }) => Promise<SwitchResult>;
    listLlmProfiles: () => Promise<{ activeId?: string; profiles: PublicProfile[]; projectOverrides: boolean }>;
    saveLlmProfile: (input: ProfileInput) => Promise<{ ok: boolean; id?: string; error?: string }>;
    deleteLlmProfile: (id: string) => Promise<{ ok: boolean; error?: string }>;
    activateLlmProfile: (id: string) => Promise<{ ok: boolean; provider?: string; model?: string; error?: string; warning?: string }>;
    disableLlmProfile: (id: string) => Promise<{ ok: boolean; error?: string }>;
    listModelsForProfile: (input: ProfileInput) => Promise<{ models?: string[]; error?: string }>;
  }> = {},
): Promise<void> {
  const hub = new SseHub();
  const agent = fakeAgent(agentOverrides);
  const permissions = fakePermissions();
  const runtime = new GuiRuntime(hub);
  runtime.attach(agent, permissions);
  const project = {
    cwd: agent.cwd,
    agent,
    permissions,
    hooks: { list: () => [] } as never,
    customCommands: new Map(),
    mcp: null,
  };
  const gui = await startGuiServer(
    {
      project,
      hub,
      runtime,
      token: TOKEN,
      switchProject: serverOverrides.switchProject ?? (async (cwd) => ({ ok: true, cwd, sessionId: agent.sessionId })),
      newSession: async () => ({ id: "new1" }),
      resumeSession: async () => null,
      listSessions: async () => [],
      searchSessions: serverOverrides.searchSessions ?? (async () => []),
      tagSession: serverOverrides.tagSession ?? (async () => null),
      renameSession: serverOverrides.renameSession ?? (async () => true),
      deleteSession: serverOverrides.deleteSession ?? (async () => ({ ok: true })),
      listLlmProfiles: serverOverrides.listLlmProfiles ?? (async () => ({ profiles: [], projectOverrides: false })),
      saveLlmProfile: serverOverrides.saveLlmProfile ?? (async () => ({ ok: true, id: "p_1" })),
      deleteLlmProfile: serverOverrides.deleteLlmProfile ?? (async () => ({ ok: true })),
      activateLlmProfile: serverOverrides.activateLlmProfile ?? (async () => ({ ok: true, provider: "anthropic", model: "m" })),
      disableLlmProfile: serverOverrides.disableLlmProfile ?? (async () => ({ ok: true })),
      listModelsForProfile: serverOverrides.listModelsForProfile ?? (async () => ({ models: ["m1"] })),
      onQuit: () => {},
    },
    0,
  );
  try {
    await fn(gui, runtime, agent);
  } finally {
    await gui.close();
  }
}

function req(port: number, path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers["x-agent-token"] = opts.token;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const r = http.request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, json, text: data });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe("gui server", () => {
  it("broadcasts round and tool events with structured input and result", async () => {
    await withServer(
      async (gui) => {
        const sse = collectSse(gui.port, 4);
        await sse.ready;
        await req(gui.port, "/api/chat", { method: "POST", token: TOKEN, body: { text: "hi" } });
        const events = (await sse.done).slice(0, 4);
        expect(events.map((e) => e.event)).toEqual(["turn_start", "round_start", "tool_start", "tool_end"]);
        expect(events[1].data.round).toBe(1);
        expect(events[2].data.input).toEqual({ path: "a.ts" });
        expect(events[3].data.result).toBe("file body");
      },
      {
        chat: async (_text, _signal, events) => {
          events?.onRoundStart?.(1);
          events?.onToolStart?.("t1", "read_file", '{"path":"a.ts"}', { path: "a.ts" });
          events?.onToolEnd?.("t1", "read_file", true, "file body", "file body");
          return "done";
        },
      },
    );
  });

  it("serves the vendored marked build", async () => {
    await withServer(async (gui) => {
      const r = await req(gui.port, "/vendor/marked.min.js");
      expect(r.status).toBe(200);
      expect(r.text).toContain("marked");
    });
  });

  it("serves the app icon without a token", async () => {
    await withServer(async (gui) => {
      const r = await req(gui.port, "/icon.png");
      expect(r.status).toBe(200);
      expect(r.text).toContain("PNG");
      const ico = await req(gui.port, "/favicon.ico");
      expect(ico.status).toBe(200);
    });
  });

  it("rejects /api/* without the token", async () => {
    await withServer(async (gui) => {
      const r = await req(gui.port, "/api/state");
      expect(r.status).toBe(401);
    });
  });

  it("serves /api/state with the token", async () => {
    await withServer(async (gui) => {
      const r = await req(gui.port, "/api/state", { token: TOKEN });
      expect(r.status).toBe(200);
      expect(r.json.sessionId).toBe("sess1");
      expect(r.json.model).toBe("glm-5.3-flash");
      expect(Array.isArray(r.json.transcript)).toBe(true);
    });
  });

  it("serves the static index without a token", async () => {
    await withServer(async (gui) => {
      const r = await req(gui.port, "/");
      expect(r.status).toBe(200);
      expect(r.text).toContain("<!doctype html>");
    });
  });

  it("returns 409 when a turn is already running", async () => {
    await withServer(async (gui, runtime) => {
      runtime.busy = true;
      const r = await req(gui.port, "/api/chat", { method: "POST", token: TOKEN, body: { text: "hi" } });
      expect(r.status).toBe(409);
    });
  });

  it("/api/project rejects a missing cwd", async () => {
    await withServer(async (gui) => {
      const r = await req(gui.port, "/api/project", { method: "POST", token: TOKEN, body: {} });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("missing cwd");
    });
  });

  it("/api/project returns 409 while busy", async () => {
    await withServer(async (gui, runtime) => {
      runtime.busy = true;
      const r = await req(gui.port, "/api/project", { method: "POST", token: TOKEN, body: { cwd: "/tmp/other" } });
      expect(r.status).toBe(409);
    });
  });

  it("/api/project forwards the directory and returns the new cwd", async () => {
    const calls: string[] = [];
    await withServer(
      async (gui) => {
        const r = await req(gui.port, "/api/project", {
          method: "POST",
          token: TOKEN,
          body: { cwd: " D:\\work\\other " },
        });
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ ok: true, cwd: "/tmp/new", sessionId: "sess2" });
        expect(calls).toEqual(["D:\\work\\other"]);
      },
      {},
      {
        switchProject: async (cwd) => {
          calls.push(cwd);
          return { ok: true, cwd: "/tmp/new", sessionId: "sess2" };
        },
      },
    );
  });

  it("/api/project surfaces a switch error", async () => {
    await withServer(
      async (gui) => {
        const r = await req(gui.port, "/api/project", { method: "POST", token: TOKEN, body: { cwd: "/nope" } });
        expect(r.status).toBe(400);
        expect(r.json.error).toContain("directory not found");
      },
      {},
      { switchProject: async (cwd) => ({ ok: false, error: `directory not found: ${cwd}` }) },
    );
  });

  it("runs a chat turn and broadcasts SSE events", async () => {
    await withServer(
      async (gui, runtime, agent) => {
        let chatCalled = false;
        (agent as unknown as { chat: (...a: unknown[]) => Promise<string> }).chat = async (_t, _s, events) => {
          chatCalled = true;
          events?.onThinkingDelta?.("thinking hard");
          events?.onToolUseStart?.("read_file", "t1");
          events?.onTextDelta?.("hel");
          events?.onTextDelta?.("lo");
          events?.onToolStart?.("t1", "read_file", '{"path":"a"}');
          events?.onToolEnd?.("t1", "read_file", true, "contents");
          return "hello";
        };
        // Open an SSE stream first so we capture events.
        const sse = collectSse(gui.port, 8);
        await sse.ready;
        const post = await req(gui.port, "/api/chat", { method: "POST", token: TOKEN, body: { text: "say hi" } });
        expect(post.status).toBe(202);
        const got = await sse.done;
        expect(chatCalled).toBe(true);
        expect(got.map((f) => f.event)).toEqual(
          expect.arrayContaining(["turn_start", "thinking_delta", "tool_use_start", "text_delta", "tool_start", "tool_end", "turn_end"]),
        );
        const deltas = got.filter((f) => f.event === "text_delta").map((f) => f.data.d);
        expect(deltas.join("")).toBe("hello");
        const thinking = got.filter((f) => f.event === "thinking_delta").map((f) => f.data.d);
        expect(thinking.join("")).toBe("thinking hard");
        // tool_use_start registers the card once; tool_start must not duplicate it.
        expect(got.filter((f) => f.event === "tool_start")).toHaveLength(1);
        expect(runtime.liveTurn).toBeNull();
      },
    );
  });

  it("permission round-trip resolves the parked promise", async () => {
    await withServer(async (gui, runtime) => {
      const sse = collectSse(gui.port, 1);
      await sse.ready;
      const promise = runtime.askPermission("write src/a.ts", "medium", "+ new line");
      const first = await sse.done;
      const req1 = first.find((f) => f.event === "permission_request")!;
      expect(req1.data.description).toBe("write src/a.ts");
      const r = await req(gui.port, "/api/permission", { method: "POST", token: TOKEN, body: { id: req1.data.id, decision: "always" } });
      expect(r.status).toBe(200);
      await expect(promise).resolves.toBe("always");
    });
  });

  it("abort flushes a pending permission with 'no'", async () => {
    await withServer(async (gui, runtime) => {
      const promise = runtime.askPermission("rm -rf /", "high");
      expect(runtime.pendingCount).toBe(1);
      await req(gui.port, "/api/abort", { method: "POST", token: TOKEN, body: {} });
      await expect(promise).resolves.toBe("no");
      expect(runtime.pendingCount).toBe(0);
    });
  });

  it("double-answering a permission 404s the second time", async () => {
    await withServer(async (gui, runtime) => {
      const sse = collectSse(gui.port, 1);
      await sse.ready;
      const promise = runtime.askPermission("edit", "medium");
      const first = await sse.done;
      const id = first.find((f) => f.event === "permission_request")!.data.id;
      await req(gui.port, "/api/permission", { method: "POST", token: TOKEN, body: { id, decision: "yes" } });
      const second = await req(gui.port, "/api/permission", { method: "POST", token: TOKEN, body: { id, decision: "no" } });
      expect(second.status).toBe(404);
      await expect(promise).resolves.toBe("yes");
    });
  });

  it("renames a session via the endpoint", async () => {
    await withServer(async (gui) => {
      const r = await req(gui.port, "/api/session/rename", { method: "POST", token: TOKEN, body: { id: "abcd", title: "my chat" } });
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
    });
  });

  it("deleting a missing session 404s", async () => {
    await withServer(
      async (gui) => {
        const missing = await req(gui.port, "/api/session/delete", { method: "POST", token: TOKEN, body: { id: "abcd" } });
        expect(missing.status).toBe(404);
        expect(missing.json.error).toBe("session not found");
        const noToken = await req(gui.port, "/api/session/rename", { method: "POST", body: { id: "abcd", title: "x" } });
        expect(noToken.status).toBe(401);
      },
      {},
      { deleteSession: async () => ({ ok: false, error: "session not found" }) },
    );
  });

  it("/api/session/tags saves and clears tags", async () => {
    await withServer(
      async (gui) => {
        const saved = await req(gui.port, "/api/session/tags", { method: "POST", token: TOKEN, body: { id: "abcd", tags: [" bug ", "perf", ""] } });
        expect(saved.status).toBe(200);
        expect(saved.json).toEqual({ ok: true, tags: ["bug", "perf"] });
        const missing = await req(gui.port, "/api/session/tags", { method: "POST", token: TOKEN, body: { id: "nope", tags: [] } });
        expect(missing.status).toBe(404);
      },
      {},
      {
        tagSession: async (_id, tags) => {
          const clean = [...new Set(tags.map((t) => t.trim().slice(0, 24)).filter(Boolean))];
          return clean.length ? clean : null; // mirrors session.ts normalization
        },
      },
    );
  });

  it("/api/search proxies query+regex to searchSessions", async () => {
    const calls: Array<{ q: string; regex: boolean }> = [];
    await withServer(
      async (gui) => {
        const hit = await req(gui.port, "/api/search?q=websocket%20timeout", { token: TOKEN });
        expect(hit.status).toBe(200);
        expect(hit.json).toHaveLength(1);
        expect(hit.json[0].meta.id).toBe("abcd1234");

        const empty = await req(gui.port, "/api/search", { token: TOKEN });
        expect(empty.status).toBe(400);

        const regex = await req(gui.port, "/api/search?q=%5Cd%7B4%7D&regex=1", { token: TOKEN });
        expect(regex.status).toBe(200);
        expect(calls[calls.length - 1]).toEqual({ q: "\\d{4}", regex: true });
      },
      {},
      {
        searchSessions: async (q, o) => {
          calls.push({ q, regex: !!o?.regex });
          return q.includes("websocket")
            ? [{ meta: { id: "abcd1234", cwd: "/tmp", updatedAt: "2026-09-10T10:00:00.000Z" }, matches: 2, snippet: "…websocket…", titleMatch: false }]
            : [];
        },
      },
    );
  });
  it("/api/llm/profiles passes the masked list through", async () => {
    await withServer(
      async (gui) => {
        const r = await req(gui.port, "/api/llm/profiles", { token: TOKEN });
        expect(r.status).toBe(200);
        expect(r.json.activeId).toBe("p_1");
        expect(r.json.projectOverrides).toBe(false);
        expect(r.json.profiles[0].keyMasked).toBe("sk-1…cd9f");
        expect(r.json.profiles[0].apiKey).toBeUndefined();
      },
      {},
      {
        listLlmProfiles: async () => ({
          activeId: "p_1",
          projectOverrides: false,
          profiles: [
            { id: "p_1", name: "网关", provider: "openai", model: "glm-4.6", updatedAt: "2026-10-18T00:00:00.000Z", hasKey: true, keyMasked: "sk-1…cd9f" },
          ],
        }),
      },
    );
  });

  it("/api/llm/profile/save rejects a missing model and trims what it forwards", async () => {
    const seen: ProfileInput[] = [];
    await withServer(
      async (gui) => {
        const bad = await req(gui.port, "/api/llm/profile/save", { method: "POST", token: TOKEN, body: { name: "只有名字" } });
        expect(bad.status).toBe(400);
        expect(seen).toHaveLength(0);

        const ok = await req(gui.port, "/api/llm/profile/save", {
          method: "POST",
          token: TOKEN,
          body: { id: "p_1", name: " 网关 ", provider: "openai", baseURL: " https://gw.example/v1 ", apiKey: " sk-abc ", model: " glm-4.6 " },
        });
        expect(ok.status).toBe(200);
        expect(ok.json).toEqual({ ok: true, id: "p_9" });
        expect(seen[0]).toEqual({
          id: "p_1",
          name: "网关",
          provider: "openai",
          baseURL: "https://gw.example/v1",
          apiKey: "sk-abc",
          model: "glm-4.6",
        });
      },
      {},
      {
        saveLlmProfile: async (input) => {
          seen.push(input);
          return { ok: true, id: "p_9" };
        },
      },
    );
  });

  it("/api/llm/profile/activate maps busy to 409 and a missing profile to 404", async () => {
    await withServer(
      async (gui) => {
        const busy = await req(gui.port, "/api/llm/profile/activate", { method: "POST", token: TOKEN, body: { id: "p_1" } });
        expect(busy.status).toBe(409);
        expect(busy.json.error).toBe("busy");

        const gone = await req(gui.port, "/api/llm/profile/activate", { method: "POST", token: TOKEN, body: { id: "nope" } });
        expect(gone.status).toBe(404);
      },
      {},
      {
        activateLlmProfile: async (id) => (id === "nope" ? { ok: false, error: "not found" } : { ok: false, error: "busy" }),
      },
    );
  });

  it("/api/llm/profile/delete reports an unknown id as 404", async () => {
    await withServer(
      async (gui) => {
        const missing = await req(gui.port, "/api/llm/profile/delete", { method: "POST", token: TOKEN, body: { id: "nope" } });
        expect(missing.status).toBe(404);
        const ok = await req(gui.port, "/api/llm/profile/delete", { method: "POST", token: TOKEN, body: { id: "p_1" } });
        expect(ok.status).toBe(200);
      },
      {},
      { deleteLlmProfile: async (id) => (id === "p_1" ? { ok: true } : { ok: false, error: "not found" }) },
    );
  });

  it("/api/llm/profile/disable reports an unknown id as 404", async () => {
    await withServer(
      async (gui) => {
        const missing = await req(gui.port, "/api/llm/profile/disable", { method: "POST", token: TOKEN, body: { id: "nope" } });
        expect(missing.status).toBe(404);
        const ok = await req(gui.port, "/api/llm/profile/disable", { method: "POST", token: TOKEN, body: { id: "p_1" } });
        expect(ok.status).toBe(200);
        expect(ok.json).toEqual({ ok: true });
      },
      {},
      { disableLlmProfile: async (id) => (id === "p_1" ? { ok: true } : { ok: false, error: "not found" }) },
    );
  });

  it("/api/llm/models lists a draft config and maps an endpoint failure to 502", async () => {
    await withServer(
      async (gui) => {
        const ok = await req(gui.port, "/api/llm/models", {
          method: "POST",
          token: TOKEN,
          body: { provider: "openai", model: "", apiKey: "sk-x" },
        });
        expect(ok.status).toBe(200);
        expect(ok.json.models).toEqual(["m1"]);

        // An empty key is dropped by the parser, so the callback reports failure.
        const bad = await req(gui.port, "/api/llm/models", { method: "POST", token: TOKEN, body: { provider: "openai", model: "", apiKey: "" } });
        expect(bad.status).toBe(502);
        expect(bad.json.error).toMatch(/401/);
      },
      {},
      {
        listModelsForProfile: async (input) => (input.apiKey ? { models: ["m1"] } : { error: "401 unauthorized" }),
      },
    );
  });
});

/** Connect to the SSE endpoint; resolve `ready` once the server registered us,
 *  and `done` once `count` named events have arrived. */
function collectSse(port: number, count: number): { ready: Promise<void>; done: Promise<Array<{ event: string; data: any }>> } {
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));
  const done = new Promise<Array<{ event: string; data: any }>>((resolve) => {
    const out: Array<{ event: string; data: any }> = [];
    const r = http.get({ host: "127.0.0.1", port, path: `/api/events?token=${TOKEN}`, headers: { accept: "text/event-stream" } }, (res) => {
      markReady();
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event:\s*(.+)$/m.exec(frame);
          const dt = /^data:\s*(.+)$/m.exec(frame);
          if (ev && dt) {
            try {
              out.push({ event: ev[1].trim(), data: JSON.parse(dt[1]) });
            } catch {
              /* ignore malformed */
            }
          }
          if (out.length >= count) {
            r.destroy();
            resolve(out);
          }
        }
      });
    });
    r.on("error", () => {
      /* destroyed on purpose */
    });
  });
  return { ready, done };
}
