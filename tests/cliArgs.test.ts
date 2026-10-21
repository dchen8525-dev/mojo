import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cliArgs.js";

describe("parseArgs", () => {
  it("returns defaults for empty argv", () => {
    const args = parseArgs([]);
    expect(args.exportFormat).toBe("md");
    expect(args.gui).toBe(false);
    expect(args.plan).toBe(false);
    expect(args.port).toBe(0);
  });

  it("consumes a valid --format value", () => {
    expect(parseArgs(["--export", "abc", "--format", "json"]).exportFormat).toBe("json");
    expect(parseArgs(["--format", "md"]).exportFormat).toBe("md");
  });

  it("does not swallow the next flag when --format has no valid value", () => {
    const args = parseArgs(["--format", "--gui"]);
    expect(args.gui).toBe(true);
    expect(args.exportFormat).toBe("md");

    const invalid = parseArgs(["--format", "xml", "--plan"]);
    expect(invalid.plan).toBe(true);
    expect(invalid.exportFormat).toBe("md");
  });

  it("parses value flags and booleans", () => {
    const args = parseArgs([
      "--resume", "s1", "--continue", "-p", "hi", "--model", "m", "--provider", "openai",
      "--theme", "light", "--port", "4310", "--auto", "--yolo", "--plan",
      "--mcp-server", "--no-mcp", "--no-lsp", "--gui", "-v",
    ]);
    expect(args).toMatchObject({
      resume: "s1", cont: true, print: "hi", model: "m", provider: "openai",
      theme: "light", port: 4310, auto: true, yolo: true, plan: true,
      mcpServer: true, noMcp: true, noLsp: true, gui: true, version: true,
    });
  });
});
