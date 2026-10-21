import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../src/gui/static/${name}`, import.meta.url)), "utf8");
const html = read("index.html");
const app = read("app.js");
const css = read("style.css");
const preload = readFileSync(fileURLToPath(new URL("../src/gui/electron/preload.cts", import.meta.url)), "utf8");

describe("GUI static assets", () => {
  it("has no inline scripts, so CSP can stay locked to same-origin", () => {
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i);
  });

  it("exposes /context and /tag in the slash palette", () => {
    expect(app).toContain('["/context"');
    expect(app).toContain('["/tag "');
  });

  it("wires the background task panel end to end", () => {
    for (const id of ["background-btn", "bg-count", "background-pop", "bg-close", "bg-list"]) {
      expect(html).toContain(`id="${id}"`);
      expect(app).toContain(`"#${id}"`);
    }
    expect(app).toContain("/api/background");
    expect(app).toContain("/api/background/kill");
    expect(css).toContain("#background-pop");
  });

  it("wires recent projects into the project dialog", () => {
    expect(html).toContain('id="proj-recent"');
    expect(app).toContain('"#proj-recent"');
    expect(app).toContain("/api/recent-projects");
    expect(css).toContain(".recent-list");
  });

  it("wires the usage dashboard and budget controls", () => {
    for (const id of [
      "usage-btn",
      "usage-modal",
      "usage-close",
      "usage-cards",
      "usage-models",
      "usage-days",
      "usage-sessions",
      "usage-ledger",
      "budget-input",
      "budget-save",
      "budget-clear",
      "budget-note",
    ]) {
      expect(html).toContain(`id="${id}"`);
      expect(app).toContain(`"#${id}"`);
    }
    expect(app).toContain("/api/usage");
    expect(app).toContain("/api/usage/budget");
    expect(css).toContain(".usage-cards");
    expect(css).toContain(".usage-budget");
  });

  it("wires the MCP and permission manager", () => {
    for (const id of [
      "manage-btn",
      "manage-modal",
      "manage-close",
      "mcp-pane",
      "mcp-list",
      "mcp-editor",
      "mcp-save",
      "mcp-reload",
      "mcp-cancel",
      "perm-pane",
      "perm-list",
      "perm-editor",
      "perm-save",
      "perm-cancel",
    ]) {
      expect(html).toContain(`id="${id}"`);
      expect(app).toContain(`"#${id}"`);
    }
    expect(app).toContain("#manage-tabs button");
    expect(app).toContain("/api/mcp/save");
    expect(app).toContain("/api/mcp/delete");
    expect(app).toContain("/api/mcp/reload");
    expect(app).toContain("/api/permissions/add");
    expect(app).toContain("/api/permissions/delete");
    expect(css).toContain(".manage-tabs");
    expect(css).toContain(".status-dot");
  });

  it("wires drag-and-drop attachments through the Electron preload", () => {
    expect(html).toContain('id="drop-hint"');
    expect(app).toContain("addDroppedFiles");
    expect(app).toContain("getPathForFile");
    expect(app).toContain("relativeToCwd");
    expect(app).toContain('addEventListener("drop"');
    expect(css).toContain(".drop-hint");
    expect(preload).toContain("getPathForFile");
    expect(preload).toContain("webUtils");
  });

  it("wires the todo panel to the state snapshot", () => {
    for (const id of ["todo-btn", "todo-count", "todo-pop", "todo-close", "todo-list", "todo-summary"]) {
      expect(html).toContain(`id="${id}"`);
      expect(app).toContain(`"#${id}"`);
    }
    expect(app).toContain("renderTodos");
    expect(app).toContain("state.todos");
    expect(app).toContain('d.name === "todo_write"');
    expect(css).toContain(".todo-row");
    expect(css).toContain(".todo-summary");
  });

  it("turns the sidebar into an off-canvas drawer on narrow screens", () => {
    expect(html).toContain('id="sidebar-toggle"');
    expect(html).toContain('id="sidebar-overlay"');
    expect(app).toContain("setSidebarOpen");
    expect(app).toContain("(max-width: 860px)");
    expect(app).toContain("sidebarToggle.setAttribute(\"aria-expanded\"");
    expect(css).toContain("#sidebar.open");
    expect(css).toContain(".sidebar-overlay");
    expect(css).toContain("transform: translateX(-100%)");
    expect(app).toContain('$("#main").inert = next');
    expect(app).toContain("drawer-locked");
    expect(css).toContain("body.drawer-locked");
  });

  it("binds Ctrl/Cmd+K and Ctrl/Cmd+Enter", () => {
    expect(app).toContain('e.key.toLowerCase() === "k"');
    expect(app).toContain('e.key === "Enter" && (e.ctrlKey || e.metaKey)');
    expect(app).toContain("openSessionSearch");
    expect(app).toContain("sessionSearch.select()");
  });

  it("reflects popup state on their toolbar buttons", () => {
    expect(app).toContain('$("#todo-btn").setAttribute("aria-expanded"');
    expect(app).toContain('$("#background-btn").setAttribute("aria-expanded"');
    expect(html).toContain('aria-controls="todo-pop"');
    expect(html).toContain('aria-controls="background-pop"');
  });

  it("lets the composer action bar wrap on very narrow screens", () => {
    expect(css).toMatch(/\.composer-bar\s*\{\s*flex-wrap:\s*wrap;/);
    expect(css).toMatch(/\.bar-right\s*\{[^}]*flex-wrap:\s*wrap;/);
  });

  it("adds a shortcut reference and mobile drawer swipes", () => {
    for (const id of ["help-btn", "help-modal", "help-close"]) {
      expect(html).toContain(`id="${id}"`);
      expect(app).toContain(`"#${id}"`);
    }
    expect(html).toContain('id="help-list"');
    expect(app).toContain('e.key === "?"');
    expect(app).toContain("openHelp");
    expect(app).toContain("closeHelp");
    expect(app).toContain('"touchstart"');
    expect(app).toContain('"touchend"');
    expect(app).toContain("swipeStartX <= 24");
    expect(css).toContain(".help-row");
    expect(css).toContain(".help-card");
  });

  it("guards IME input and races in the todo panel", () => {
    expect(app).toContain("e.isComposing || e.keyCode === 229");
    expect(app).toContain("todoSyncSeq");
    expect(app).toContain("todoSyncEpoch");
    expect(app).toContain('$("#model-pop").classList.add("hidden")');
    expect(app).toContain("list.scrollTop = scrollTop");
    expect(html).toContain('aria-controls="sidebar"');
    expect(app).toContain('$("#new-session").focus({ preventScroll: true })');
    expect(app).toContain("sidebarToggle.focus({ preventScroll: true })");
  });
});
