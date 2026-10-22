import { createCronTask, deleteCronTask, formatCronTask, loadCronTasks, validateCron } from "../cron.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

/** Scheduled runs must never schedule more runs (fork-bomb guard). */
function inScheduledRun(): boolean {
  return !!process.env.AGENT_CRON_RUN;
}

function stringField(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? (input[key] as string).trim() : "";
}

export const cronCreateTool: Tool = {
  name: "cron_create",
  description:
    "Schedule a recurring agent task. The expression is the classic 5-field cron in local time " +
    "(minute hour day-of-month month day-of-week, e.g. '0 9 * * 1-5'). Each fire spawns a fresh " +
    "headless agent run in the given working directory with the prompt, so write the prompt as a " +
    "self-contained instruction. The user must approve creation.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      cron: { type: "string", description: "5-field cron expression in local time" },
      prompt: { type: "string", description: "Self-contained instruction for each run" },
      name: { type: "string", description: "Short label shown in /cron and the GUI" },
      cwd: { type: "string", description: "Absolute working directory (defaults to the current one)" },
      enabled: { type: "boolean", description: "Create paused with false (default true)" },
    },
    required: ["cron", "prompt"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (inScheduledRun()) {
      return { content: "Error: scheduled tasks cannot create other scheduled tasks.", isError: true };
    }
    const cron = stringField(input, "cron");
    const prompt = stringField(input, "prompt");
    if (!cron || !prompt) return { content: "Error: cron and prompt are required", isError: true };
    const check = validateCron(cron);
    if (!check.ok) return { content: `Error: ${check.error}`, isError: true };
    const cwd = stringField(input, "cwd") || ctx.cwd;
    const name = stringField(input, "name");
    const enabled = input.enabled !== false;

    const approved = await ctx.askPermission(
      `Create scheduled task${name ? ` "${name}"` : ""} (${cron}): ${prompt.slice(0, 100)}`,
      "high",
    );
    if (!approved) return { content: "Denied: the user did not approve creating this scheduled task.", isError: true };

    try {
      const task = await createCronTask({ cron, prompt, cwd, name, enabled });
      const when = enabled ? new Date(task.nextRunAt).toLocaleString() : "paused";
      return {
        content: `Created scheduled task ${task.id} "${task.name}" (${task.cron}); next run: ${when}; cwd: ${task.cwd}.`,
      };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

export const cronListTool: Tool = {
  name: "cron_list",
  description: "List scheduled agent tasks with their cron expression, next run time and last outcome.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    try {
      const tasks = await loadCronTasks();
      if (!tasks.length) return { content: "No scheduled tasks." };
      return { content: `Scheduled tasks (${tasks.length}):\n${tasks.map(formatCronTask).join("\n")}` };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

export const cronDeleteTool: Tool = {
  name: "cron_delete",
  description: "Delete a scheduled agent task by id (see cron_list). The user must approve deletion.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Task id such as cr_1a2b3c4d" } },
    required: ["id"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (inScheduledRun()) {
      return { content: "Error: scheduled tasks cannot modify the schedule from inside a run.", isError: true };
    }
    const id = stringField(input, "id");
    if (!id) return { content: "Error: id is required", isError: true };
    try {
      const tasks = await loadCronTasks();
      const task = tasks.find((t) => t.id === id);
      if (!task) return { content: `Error: scheduled task "${id}" not found`, isError: true };
      const approved = await ctx.askPermission(`Delete scheduled task "${task.name}" (${task.cron})`, "high");
      if (!approved) return { content: "Denied: the user did not approve deleting this scheduled task.", isError: true };
      const deleted = await deleteCronTask(id);
      if (!deleted) return { content: `Error: scheduled task "${id}" not found`, isError: true };
      return { content: `Deleted scheduled task ${id}.` };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
