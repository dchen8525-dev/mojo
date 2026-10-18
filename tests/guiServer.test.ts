import { describe, expect, it } from "vitest";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "../src/agent.js";
import type { PermissionManager } from "../src/permissions.js";
import { SseHub } from "../src/gui/sse.js";
import { GuiRuntime } from "../src/gui/state.js";
import { startGuiServer, type RunningGui } from "../src/gui/server.js";
import type { SwitchResult } from "../src/gui/project.js";

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
    home: string;
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
      home: serverOverrides.home,
      switchProject: serverOverrides.switchProject ?? (async (cwd) => ({ ok: true, cwd, sessionId: agent.sessionId })),
      newSession: async () => ({ id: "new1" }),
      resumeSession: async () => null,
      listSessions: async () => [],
      searchSessions: serverOverrides.searchSessions ?? (async () => []),
      tagSession: serverOverrides.tagSession ?? (async () => null),
      renameSession: serverOverrides.renameSession ?? (async () => true),
      deleteSession: serverOverrides.deleteSession ?? (async () => ({ ok: true })),
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

  it("GET /api/api-profiles returns a masked empty view", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-gui-home-"));
    try {
      await withServer(
        async (gui) => {
          const r = await req(gui.port, "/api/api-profiles", { token: TOKEN });
          expect(r.status).toBe(200);
          expect(r.json.profiles).toEqual([]);
          expect(r.json.defaultProfileId).toBeNull();
          expect(r.json.activeProfileId).toBeNull();
          expect(r.json.config.global).toContain(".node-agent");
        },
        {},
        { home },
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("POST /api/api-profiles creates a profile, masks the key and applies it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-gui-home-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-gui-proj-"));
    try {
      await withServer(
        async (gui) => {
          const r = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: {
              name: "Corp",
              provider: "openai",
              model: "gpt-4o",
              baseURL: "https://example.test/v1",
              apiKey: "sk-test",
            },
          });
          expect(r.status).toBe(200);
          expect(r.json.profile).toMatchObject({
            name: "Corp",
            provider: "openai",
            model: "gpt-4o",
            baseURL: "https://example.test/v1",
            hasKey: true,
          });
          expect(r.json.profile.apiKey).toBeUndefined();
          expect(r.json.applied).toEqual({ provider: "openai", model: "gpt-4o" });

          const raw = JSON.parse(await fs.readFile(path.join(home, ".node-agent", "config.json"), "utf8"));
          expect(raw.apiProfiles[0]).toMatchObject({ name: "Corp", apiKey: "sk-test" });
        },
        {
          cwd,
          switchModel: (spec: string) => {
            const [provider, ...rest] = spec.split(":");
            return { provider, model: rest.join(":") };
          },
        },
        { home },
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("POST /api/api-profiles validates provider, name, model and baseURL", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-gui-home-"));
    try {
      await withServer(
        async (gui) => {
          const noProvider = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: { name: "x", provider: "nope", model: "m" },
          });
          expect(noProvider.status).toBe(400);
          const noName = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: { provider: "anthropic", model: "m" },
          });
          expect(noName.status).toBe(400);
          const noModel = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: { name: "x", provider: "anthropic" },
          });
          expect(noModel.status).toBe(400);
          const badURL = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: { name: "x", provider: "anthropic", model: "m", baseURL: "ftp://example.test" },
          });
          expect(badURL.status).toBe(400);
        },
        {},
        { home },
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("POST /api/api-profiles/select stores the project selection and applies it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-gui-home-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-gui-proj-"));
    const apply = (spec: string) => {
      const [provider, ...rest] = spec.split(":");
      return { provider, model: rest.join(":") };
    };
    try {
      await withServer(
        async (gui) => {
          const first = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: { name: "First", provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-a" },
          });
          const second = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: { name: "Second", provider: "openai", model: "gpt-4o", apiKey: "sk-b" },
          });
          expect(first.status).toBe(200);
          expect(second.status).toBe(200);

          const selected = await req(gui.port, "/api/api-profiles/select", {
            method: "POST",
            token: TOKEN,
            body: { scope: "project", id: second.json.profile.id },
          });
          expect(selected.status).toBe(200);
          expect(selected.json.view.projectProfileId).toBe(second.json.profile.id);
          expect(selected.json.applied).toEqual({ provider: "openai", model: "gpt-4o" });

          const project = JSON.parse(await fs.readFile(path.join(cwd, ".node-agent", "config.json"), "utf8"));
          expect(project).toEqual({ apiProfile: second.json.profile.id });
        },
        { cwd, switchModel: apply },
        { home },
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("POST /api/api-profiles/delete removes a profile and promotes the next default", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-gui-home-"));
    try {
      await withServer(
        async (gui) => {
          const first = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: { name: "First", provider: "anthropic", model: "m1", apiKey: "sk-a" },
          });
          const second = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: { name: "Second", provider: "openai", model: "m2", apiKey: "sk-b" },
          });

          const deleted = await req(gui.port, "/api/api-profiles/delete", {
            method: "POST",
            token: TOKEN,
            body: { id: first.json.profile.id },
          });
          expect(deleted.status).toBe(200);
          expect(deleted.json.view.profiles.map((p: { id: string }) => p.id)).toEqual([second.json.profile.id]);
          expect(deleted.json.view.defaultProfileId).toBe(second.json.profile.id);
        },
        {
          switchModel: (spec: string) => {
            const [provider, ...rest] = spec.split(":");
            return { provider, model: rest.join(":") };
          },
        },
        { home },
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("POST /api/api-profiles reports applyError while keeping the saved profile", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-gui-home-"));
    try {
      await withServer(
        async (gui) => {
          const r = await req(gui.port, "/api/api-profiles", {
            method: "POST",
            token: TOKEN,
            body: { name: "P", provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-test" },
          });
          expect(r.status).toBe(200);
          expect(r.json.applyError).toContain("No API key");
          expect(r.json.profile.name).toBe("P");
          const raw = JSON.parse(await fs.readFile(path.join(home, ".node-agent", "config.json"), "utf8"));
          expect(raw.apiProfiles).toHaveLength(1);
        },
        {
          switchModel: () => {
            throw new Error("No API key for provider anthropic");
          },
        },
        { home },
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("GET /api/fs/dirs lists only subdirectories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-dirs-"));
    try {
      await fs.mkdir(path.join(root, "alpha"));
      await fs.mkdir(path.join(root, "beta"));
      await fs.writeFile(path.join(root, "note.txt"), "x");
      const real = await fs.realpath(root);

      await withServer(async (gui) => {
        const r = await req(gui.port, "/api/fs/dirs?path=" + encodeURIComponent(root), { token: TOKEN });
        expect(r.status).toBe(200);
        expect(r.json.path).toBe(real);
        expect(r.json.entries.map((entry: { name: string }) => entry.name)).toEqual(["alpha", "beta"]);
        expect(r.json.entries[0].path).toBe(path.join(real, "alpha"));
        expect(typeof r.json.parent).toBe("string");
        expect(Array.isArray(r.json.roots)).toBe(true);

        const missing = await req(gui.port, "/api/fs/dirs?path=" + encodeURIComponent(path.join(root, "nope")), {
          token: TOKEN,
        });
        expect(missing.status).toBe(400);
        const file = await req(gui.port, "/api/fs/dirs?path=" + encodeURIComponent(path.join(root, "note.txt")), {
          token: TOKEN,
        });
        expect(file.status).toBe(400);
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects profile changes while a turn is running", async () => {
    await withServer(async (gui, runtime) => {
      runtime.busy = true;
      const saved = await req(gui.port, "/api/api-profiles", {
        method: "POST",
        token: TOKEN,
        body: { name: "x", provider: "anthropic", model: "m", apiKey: "sk" },
      });
      expect(saved.status).toBe(409);
      const selected = await req(gui.port, "/api/api-profiles/select", {
        method: "POST",
        token: TOKEN,
        body: { scope: "project", id: "p1" },
      });
      expect(selected.status).toBe(409);
    });
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
