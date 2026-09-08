import type { Tool, ToolContext, ToolResult } from "../types.js";

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Shared store so the CLI can render the current plan. */
export const todoStore: { items: TodoItem[] } = { items: [] };

export const todoWriteTool: Tool = {
  name: "todo_write",
  description:
    "Create or update a task list for the current job. Use it for any task with 3+ distinct " +
    "steps: plan first, then keep exactly one item in_progress and mark items completed as " +
    "soon as they are done. Pass the FULL list every time (it replaces the previous one).",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["id", "content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const raw = input.todos;
    if (!Array.isArray(raw)) return { content: "Error: todos must be an array", isError: true };
    const items: TodoItem[] = [];
    for (const t of raw) {
      const o = t as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.content !== "string") continue;
      const status = o.status === "in_progress" || o.status === "completed" ? o.status : "pending";
      items.push({ id: o.id, content: o.content, status });
    }
    todoStore.items = items;
    const done = items.filter((i) => i.status === "completed").length;
    return { content: `Todo list updated: ${done}/${items.length} completed.` };
  },
};
