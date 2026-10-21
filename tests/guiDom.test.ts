import { readFileSync } from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(path.join(process.cwd(), "src/gui/static/index.html"), "utf8");
const appJs = readFileSync(path.join(process.cwd(), "src/gui/static/app.js"), "utf8");
const bodyHtml = html
  .slice(html.indexOf("<body>") + "<body>".length, html.indexOf("</body>"))
  .replace(/<script[\s\S]*?<\/script>/g, "");

const seededTodos = [
  { id: "1", content: "恢复后的待办", status: "in_progress" },
  { id: "2", content: "已完成项", status: "completed" },
];

const baseState = {
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
  todos: [] as typeof seededTodos,
};

type Listener = (event: { data: string }) => void;

/** Minimal EventSource so tests can drive the SSE-driven UI paths. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
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

const windows: Window[] = [];

afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
  FakeEventSource.instances.length = 0;
});

type Route = unknown | ((url: string, init?: RequestInit) => unknown);

async function boot(opts: {
  todos?: typeof seededTodos;
  state?: Record<string, unknown>;
  width?: number;
  /** Extra /api routes, either a static body or a function of the request. */
  routes?: Record<string, Route>;
} = {}) {
  const width = opts.width ?? 1280;
  const window = new Window({ url: "http://127.0.0.1:4611/#test-token", width, height: 900 });
  windows.push(window);
  FakeEventSource.instances.length = 0;
  window.document.body.innerHTML = bodyHtml;

  const w = window as unknown as Record<string, unknown> & Window;
  w.marked = { parse: (text: string) => `<p>${text}</p>`, setOptions: () => {} };
  w.DOMPurify = { sanitize: (value: string) => value };

  const state = { ...baseState, ...opts.state, todos: opts.todos ?? [] };
  const routes: Record<string, Route> = {
    "/api/sessions": [],
    "/api/models": [],
    "/api/api-profiles": { profiles: [], hasLegacyKey: false },
    "/api/background": { tasks: [] },
    ...opts.routes,
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    const body =
      route !== undefined
        ? typeof route === "function"
          ? (route as (u: string, i?: RequestInit) => unknown)(url, init)
          : route
        : url === "/api/state"
          ? state
          : {};
    return { ok: true, status: 200, json: async () => body };
  };
  w.EventSource = FakeEventSource;
  w.setInterval = () => 0;
  window.eval(appJs);

  // Boot is async: wait until refreshState applied the todos and the later
  // loaders populated the API selector.
  await vi.waitFor(
    () => {
      expect(window.document.querySelectorAll("#todo-list .todo-row").length).toBe(state.todos.length);
      expect(window.document.querySelectorAll("#api-select option").length).toBeGreaterThan(0);
    },
    { timeout: 3000 },
  );

  return { window, calls, state };
}

function key(window: Window, target: EventTarget, init: KeyboardEventInit) {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as unknown as Event);
}

describe("GUI interactions (happy-dom)", () => {
  it("renders restored todos and toggles the popover", async () => {
    const { window } = await boot({ todos: seededTodos });
    const doc = window.document;

    expect(doc.querySelector("#todo-summary")?.textContent).toBe("1/2 已完成");
    expect(doc.querySelector("#todo-count")?.textContent).toBe("1");
    const rows = [...doc.querySelectorAll("#todo-list .todo-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].className).toContain("in_progress");
    expect(rows[0].textContent).toContain("恢复后的待办");
    expect(rows[1].className).toContain("completed");

    (doc.querySelector("#todo-btn") as HTMLElement).click();
    expect(doc.querySelector("#todo-pop")?.classList.contains("hidden")).toBe(false);
    expect(doc.querySelector("#todo-btn")?.getAttribute("aria-expanded")).toBe("true");

    (doc.querySelector("#todo-close") as HTMLElement).click();
    expect(doc.querySelector("#todo-pop")?.classList.contains("hidden")).toBe(true);
    expect(doc.querySelector("#todo-btn")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("refreshes the todo panel when todo_write ends over SSE", async () => {
    const { window, state } = await boot({ todos: seededTodos });
    const doc = window.document;

    state.todos = [{ id: "3", content: "新的待办", status: "pending" }];
    FakeEventSource.instances[0].emit("tool_end", { id: "t1", name: "todo_write", ok: true, preview: "ok" });

    await vi.waitFor(() => {
      expect(doc.querySelector("#todo-summary")?.textContent).toBe("0/1 已完成");
      expect(doc.querySelector("#todo-list")?.textContent).toContain("新的待办");
    });
  });

  it("opens help with ? and restores focus on Escape", async () => {
    const { window } = await boot();
    const doc = window.document;
    const newSession = doc.querySelector("#new-session") as HTMLElement;
    newSession.focus();
    expect(doc.activeElement?.id).toBe("new-session");

    key(window, doc, { key: "?" });
    expect(doc.querySelector("#help-modal")?.classList.contains("hidden")).toBe(false);
    expect(doc.activeElement?.id).toBe("help-close");

    key(window, doc, { key: "Escape" });
    expect(doc.querySelector("#help-modal")?.classList.contains("hidden")).toBe(true);
    expect(doc.activeElement?.id).toBe("new-session");
  });

  it("does not open help while typing in the composer", async () => {
    const { window } = await boot();
    const doc = window.document;
    const input = doc.querySelector("#input") as HTMLElement;
    input.focus();

    key(window, input, { key: "?" });
    expect(doc.querySelector("#help-modal")?.classList.contains("hidden")).toBe(true);
    expect(doc.activeElement?.id).toBe("input");
  });

  it("opens and closes the drawer with the backdrop", async () => {
    const { window } = await boot({ width: 390 });
    const doc = window.document;
    const toggle = doc.querySelector("#sidebar-toggle") as HTMLElement;

    toggle.click();
    expect(doc.querySelector("#sidebar")?.classList.contains("open")).toBe(true);
    expect((doc.querySelector("#main") as HTMLElement & { inert?: boolean }).inert).toBe(true);
    expect(doc.body.classList.contains("drawer-locked")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    (doc.querySelector("#sidebar-overlay") as HTMLElement).click();
    expect(doc.querySelector("#sidebar")?.classList.contains("open")).toBe(false);
    expect((doc.querySelector("#main") as HTMLElement & { inert?: boolean }).inert).toBe(false);
    expect(doc.body.classList.contains("drawer-locked")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("sends the composer text on Ctrl+Enter", async () => {
    const { window, calls } = await boot();
    const doc = window.document;
    const input = doc.querySelector("#input") as HTMLTextAreaElement;
    input.value = "hello from dom";
    input.focus();

    key(window, input, { key: "Enter", ctrlKey: true });

    await vi.waitFor(() => expect(calls.some((c) => c.url === "/api/chat")).toBe(true));
    const chat = calls.find((c) => c.url === "/api/chat")!;
    expect(JSON.parse(String(chat.init?.body))).toEqual({ text: "hello from dom" });
    expect(input.value).toBe("");
  });

  it("renders retry notices pushed over SSE", async () => {
    const { window } = await boot();
    FakeEventSource.instances[0].emit("retry", {
      attempt: 2,
      maxAttempts: 3,
      delayMs: 7000,
      status: 503,
      reason: "server",
    });

    expect(window.document.querySelector("#transcript")?.textContent).toContain("7 秒后重试（2/3 · 服务端错误 503）");
  });

  it("adds MCP servers and permission rules through the manage dialog", async () => {
    const servers = [
      {
        name: "filesystem",
        scope: "global",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        env: {},
        disabled: false,
        shadowed: false,
        status: "connected",
        toolCount: 4,
        error: null,
      },
    ];
    const rules = {
      global: [{ match: "WebFetch(*)", decision: "deny" }],
      project: [{ match: "Bash(npm test)", decision: "allow" }],
      mode: "default",
    };
    const { window, calls } = await boot({
      routes: {
        "/api/mcp": () => ({ servers, disabled: false }),
        "/api/permissions": () => rules,
        "/api/mcp/save": (_url, init) => {
          const req = JSON.parse(String(init?.body));
          servers.push({
            name: req.name,
            scope: req.scope,
            command: req.config.command,
            args: req.config.args,
            env: req.config.env,
            disabled: false,
            shadowed: false,
            status: "connected",
            toolCount: 2,
            error: null,
          });
          return { servers, disabled: false };
        },
        "/api/permissions/add": (_url, init) => {
          const req = JSON.parse(String(init?.body));
          (req.scope === "project" ? rules.project : rules.global).push({
            match: req.match,
            decision: req.decision,
          });
          return rules;
        },
      },
    });
    const doc = window.document;

    (doc.querySelector("#manage-btn") as HTMLElement).click();
    await vi.waitFor(() => expect(doc.querySelectorAll("#mcp-list .profile-row")).toHaveLength(1));
    expect(doc.querySelector("#manage-modal")?.classList.contains("hidden")).toBe(false);
    expect(doc.querySelector("#mcp-list")?.textContent).toContain("filesystem");
    expect(doc.querySelector("#mcp-list")?.textContent).toContain("已连接 · 4 个工具");

    (doc.querySelector("#mcp-add") as HTMLElement).click();
    expect(doc.querySelector("#mcp-editor")?.classList.contains("hidden")).toBe(false);
    (doc.querySelector("#mcp-name") as HTMLInputElement).value = "github";
    (doc.querySelector("#mcp-scope") as HTMLSelectElement).value = "project";
    (doc.querySelector("#mcp-command") as HTMLInputElement).value = "npx";
    (doc.querySelector("#mcp-args") as HTMLTextAreaElement).value = "-y\nserver-github";
    (doc.querySelector("#mcp-env") as HTMLTextAreaElement).value = "TOKEN=secret";
    (doc.querySelector("#mcp-save") as HTMLElement).click();

    await vi.waitFor(() => expect(doc.querySelectorAll("#mcp-list .profile-row")).toHaveLength(2));
    const save = calls.find((c) => c.url === "/api/mcp/save")!;
    expect(JSON.parse(String(save.init?.body))).toEqual({
      name: "github",
      scope: "project",
      config: { command: "npx", args: ["-y", "server-github"], env: { TOKEN: "secret" }, disabled: false },
    });
    expect(doc.querySelector("#mcp-editor")?.classList.contains("hidden")).toBe(true);

    (doc.querySelector('#manage-tabs button[data-tab="perm"]') as HTMLElement).click();
    expect(doc.querySelector("#mcp-pane")?.classList.contains("hidden")).toBe(true);
    expect(doc.querySelector("#perm-pane")?.classList.contains("hidden")).toBe(false);
    expect(doc.querySelectorAll("#perm-list .profile-row")).toHaveLength(2);
    expect(doc.querySelector("#perm-list")?.textContent).toContain("Bash(npm test)");
    expect(doc.querySelector("#perm-list")?.textContent).toContain("WebFetch(*)");

    (doc.querySelector("#perm-add") as HTMLElement).click();
    (doc.querySelector("#perm-match") as HTMLInputElement).value = "Bash(git push *)";
    (doc.querySelector("#perm-decision") as HTMLSelectElement).value = "deny";
    (doc.querySelector("#perm-scope") as HTMLSelectElement).value = "global";
    (doc.querySelector("#perm-save") as HTMLElement).click();

    await vi.waitFor(() => expect(doc.querySelectorAll("#perm-list .profile-row")).toHaveLength(3));
    const add = calls.find((c) => c.url === "/api/permissions/add")!;
    expect(JSON.parse(String(add.init?.body))).toEqual({
      scope: "global",
      match: "Bash(git push *)",
      decision: "deny",
    });
    expect(doc.querySelector("#perm-editor")?.classList.contains("hidden")).toBe(true);
  });

  it("renders the usage dashboard and saves a session budget", async () => {
    const usage = {
      totals: {
        usd: 12.34,
        requests: 42,
        sessions: 3,
        days: 5,
        cacheShare: 0.42,
        cacheRead: 123456,
        cacheWrite: 2345,
        input: 12345,
        output: 6789,
        unpriced: 0,
      },
      session: { usd: 1.5, requests: 4, budgetUsd: 5 },
      byModel: [
        { key: "claude-sonnet-4-5", usd: 12.34, requests: 42, input: 12345, output: 6789, cacheRead: 123456, cacheWrite: 2345 },
      ],
      byDay: [{ key: "2026-10-21", usd: 12.34, requests: 42, input: 12345, output: 6789, cacheRead: 123456, cacheWrite: 2345 }],
      bySession: [
        { key: "abcd1234", title: "重构会话", usd: 12.34, requests: 42, input: 12345, output: 6789, cacheRead: 123456, cacheWrite: 2345 },
      ],
      ledger: "~/.node-agent/usage.jsonl",
    };
    const { window, calls } = await boot({
      routes: { "/api/usage": usage, "/api/usage/budget": { ok: true } },
    });
    const doc = window.document;

    (doc.querySelector("#usage-btn") as HTMLElement).click();
    await vi.waitFor(() => expect(doc.querySelectorAll("#usage-cards .usage-stat")).toHaveLength(4));
    expect(doc.querySelector("#usage-modal")?.classList.contains("hidden")).toBe(false);
    expect([...doc.querySelectorAll("#usage-cards .u-value")].map((n) => n.textContent)).toEqual([
      "$12.34",
      "42.0%",
      "12k",
      "6.8k",
    ]);
    expect(doc.querySelector("#budget-note")?.textContent).toContain("已用 30%");
    expect((doc.querySelector("#budget-input") as HTMLInputElement).value).toBe("5");
    expect(doc.querySelector("#usage-models")?.textContent).toContain("claude-sonnet-4-5");
    expect(doc.querySelector("#usage-sessions")?.textContent).toContain("重构会话");
    expect(doc.querySelector("#usage-ledger")?.textContent).toContain("~/.node-agent/usage.jsonl");

    (doc.querySelector("#budget-input") as HTMLInputElement).value = "8";
    (doc.querySelector("#budget-save") as HTMLElement).click();
    await vi.waitFor(() => expect(calls.filter((c) => c.url === "/api/usage")).toHaveLength(2));
    const save = calls.find((c) => c.url === "/api/usage/budget")!;
    expect(JSON.parse(String(save.init?.body))).toEqual({ usd: 8 });
  });

  it("switches projects from the recent list", async () => {
    let current = { ...baseState, todos: [] as typeof seededTodos };
    const { window, calls } = await boot({
      routes: {
        "/api/state": () => current,
        "/api/recent-projects": [
          { name: "mojo", path: "D:\\proj" },
          { name: "other", path: "D:\\proj2" },
        ],
        "/api/project": (_url, init) => {
          const req = JSON.parse(String(init?.body));
          current = { ...current, cwd: req.cwd, sessionId: "beef5678" };
          return { cwd: req.cwd };
        },
      },
    });
    const doc = window.document;

    (doc.querySelector("#open-project") as HTMLElement).click();
    await vi.waitFor(() => expect(doc.querySelectorAll("#proj-recent .recent-row")).toHaveLength(2));
    expect(doc.querySelector("#project-modal")?.classList.contains("hidden")).toBe(false);
    expect(doc.querySelector("#proj-recent")?.textContent).toContain("D:\\proj2");

    (doc.querySelectorAll("#proj-recent .recent-row")[1] as HTMLElement).click();
    await vi.waitFor(() => expect(doc.querySelector("#crumb-cwd")?.textContent).toBe("D:\\proj2"));
    expect(doc.querySelector("#project-modal")?.classList.contains("hidden")).toBe(true);
    const open = calls.find((c) => c.url === "/api/project")!;
    expect(JSON.parse(String(open.init?.body))).toEqual({ cwd: "D:\\proj2" });
  });
});
