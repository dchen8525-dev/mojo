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

async function boot(opts: { todos?: typeof seededTodos; state?: Record<string, unknown>; width?: number } = {}) {
  const width = opts.width ?? 1280;
  const window = new Window({ url: "http://127.0.0.1:4611/#test-token", width, height: 900 });
  windows.push(window);
  FakeEventSource.instances.length = 0;
  window.document.body.innerHTML = bodyHtml;

  const w = window as unknown as Record<string, unknown> & Window;
  w.marked = { parse: (text: string) => `<p>${text}</p>`, setOptions: () => {} };
  w.DOMPurify = { sanitize: (value: string) => value };

  const state = { ...baseState, ...opts.state, todos: opts.todos ?? [] };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body =
      url === "/api/state"
        ? state
        : url === "/api/sessions" || url === "/api/models"
          ? []
          : url === "/api/api-profiles"
            ? { profiles: [], hasLegacyKey: false }
            : url === "/api/background"
              ? { tasks: [] }
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
});
