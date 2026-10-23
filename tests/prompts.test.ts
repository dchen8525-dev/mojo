import { describe, expect, it } from "vitest";
import { COMMUNICATION, TURN_COMPLETION, toolGuidance } from "../src/prompts.js";

describe("toolGuidance", () => {
  it("emits a block only when one of its tools is active", () => {
    const shellOnly = toolGuidance(["bash"]);
    expect(shellOnly).toContain("Shell (bash):");
    expect(shellOnly).not.toContain("Editing files:");
    expect(shellOnly).not.toContain("Subagents (task):");
  });

  it("is empty when no gated tool is active", () => {
    expect(toolGuidance(["read_file", "glob_files", "grep"])).toBe("");
  });

  it("does not treat read_file as permission to edit", () => {
    expect(toolGuidance(["read_file"])).toBe("");
  });

  it("covers every gated family independently", () => {
    expect(toolGuidance(["edit_file"])).toContain("Editing files:");
    expect(toolGuidance(["task"])).toContain("Subagents (task):");
    expect(toolGuidance(["web_search"])).toContain("Web:");
    expect(toolGuidance(["git_commit"])).toContain("Git:");
    expect(toolGuidance(["ask_user"])).toContain("Asking the user (ask_user):");
    expect(toolGuidance(["read_session"])).toContain("Past sessions (read_session):");
    expect(toolGuidance(["node_repl"])).toContain("Persistent Node REPL (node_repl):");
    expect(toolGuidance(["read_file"], { hasDeferred: true })).toContain("Deferred tools:");
    expect(toolGuidance(["apply_patch"])).toContain("apply_patch");
    expect(toolGuidance(["edit_file"])).not.toContain("apply_patch");
  });

  it("keeps the turn-completion contract non-empty and instruction-shaped", () => {
    expect(TURN_COMPLETION).toContain("Completing a turn:");
    expect(TURN_COMPLETION).toContain("verified");
    expect(TURN_COMPLETION).toContain("block");
  });

  it("sets communication discipline for final messages", () => {
    expect(COMMUNICATION).toContain("Communicating with the user:");
    expect(COMMUNICATION).toContain("final text message");
    expect(COMMUNICATION).toContain("Lead with the outcome");
  });
});
