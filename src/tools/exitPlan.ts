import type { Tool, ToolContext, ToolResult } from "../types.js";

/**
 * Plan-mode exit hatch. While the agent is in plan mode this is the only
 * non-read-only tool it is given: the model explores with read tools, then
 * calls exit_plan with the full implementation plan. The plan is shown to the
 * user as a permission preview; approving it flips the agent back to normal
 * (executing) mode and the same conversation continues with write access.
 */
export const exitPlanTool: Tool = {
  name: "exit_plan",
  description:
    "Finish plan mode: present your complete implementation plan to the user and ask to " +
    "execute it. Call this ONLY when the plan is concrete (files to change, order of steps, " +
    "how it will be verified). The user approves or rejects; on approval you switch to " +
    "normal mode and carry the plan out in this same conversation.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description:
          "The full plan in markdown: goal, ordered steps with file paths, risks, and how " +
          "success is verified. Self-contained - the user reads only this.",
      },
    },
    required: ["plan"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.planMode) {
      return { content: "exit_plan is only available in plan mode.", isError: true };
    }
    const plan = typeof input.plan === "string" ? input.plan.trim() : "";
    if (!plan) return { content: "Error: plan must not be empty", isError: true };
    const ok = await ctx.askPermission("Execute this plan?", "high", plan);
    if (!ok) {
      return {
        content:
          "The user rejected the plan. Stay in plan mode: ask what to change, revise, and call exit_plan again.",
        isError: true,
      };
    }
    ctx.approvePlan?.();
    return {
      content: "Plan approved. You are now in normal (executing) mode with full tool access. Carry out the plan you just presented.",
    };
  },
};
