import { describe, expect, it } from "vitest";
import {
  globMatches,
  normalizeRuleValue,
  parseStructuredRule,
  patternKind,
  patternMatches,
  splitShellCommand,
} from "../src/permissionRules.js";

describe("parseStructuredRule", () => {
  it("parses tool(pattern) rules", () => {
    expect(parseStructuredRule("bash(npm test:*)")).toEqual({ tool: "bash", pattern: "npm test:*" });
    expect(parseStructuredRule("  write_file(src/app.ts)  ")).toEqual({
      tool: "write_file",
      pattern: "src/app.ts",
    });
  });

  it("treats anything else as a legacy description rule", () => {
    expect(parseStructuredRule("Run command: npm test")).toBeNull();
    expect(parseStructuredRule("npm test (main)")).toBeNull();
    expect(parseStructuredRule("(x)")).toBeNull();
    expect(parseStructuredRule("bash(npm test")).toBeNull();
    expect(parseStructuredRule("has space(tool)")).toBeNull();
  });

  it("keeps inner parentheses as part of the pattern", () => {
    expect(parseStructuredRule("bash(echo $(date))")).toEqual({ tool: "bash", pattern: "echo $(date)" });
  });
});

describe("patternKind", () => {
  it("makes cmd:* a bash prefix and everything else exact/glob", () => {
    expect(patternKind("npm test:*", "bash")).toBe("prefix");
    expect(patternKind("npm test:*", "write_file")).toBe("glob");
    expect(patternKind("npm *", "bash")).toBe("glob");
    expect(patternKind("npm test", "bash")).toBe("exact");
  });
});

describe("patternMatches", () => {
  it("prefix matches the command itself or a longer invocation", () => {
    expect(patternMatches("npm test:*", "npm test", "prefix")).toBe(true);
    expect(patternMatches("npm test:*", "npm test --watch", "prefix")).toBe(true);
    expect(patternMatches("npm test:*", "npm\t--watch", "prefix")).toBe(false);
    expect(patternMatches("npm test:*", "npm test\t--watch", "prefix")).toBe(true);
    expect(patternMatches("npm test:*", "npm testing", "prefix")).toBe(false);
    expect(patternMatches("npm test:*", "npm run test", "prefix")).toBe(false);
  });

  it("glob is anchored to the whole value", () => {
    expect(patternMatches("src/*.ts", "src/app.ts", "glob")).toBe(true);
    expect(patternMatches("src/*.ts", "src/nested/app.ts", "glob")).toBe(true);
    expect(patternMatches("src/*.ts", "test/src/app.ts", "glob")).toBe(false);
    expect(globMatches("a[", "a[")).toBe(true); // literals are escaped, never a regex error
    expect(globMatches("a[", "ab")).toBe(false);
  });

  it("exact ignores surrounding whitespace only", () => {
    expect(patternMatches(" npm test ", "npm test", "exact")).toBe(true);
    expect(patternMatches("npm test", "npm test --watch", "exact")).toBe(false);
  });
});

describe("splitShellCommand", () => {
  it("splits on ; && || | & and newlines", () => {
    expect(splitShellCommand("npm test && npm run build | tee log").segments).toEqual([
      "npm test",
      "npm run build",
      "tee log",
    ]);
    expect(splitShellCommand("a; b || c & d\ne").segments).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps quoted separators inside one command", () => {
    const split = splitShellCommand(`echo "a; b" && echo 'c | d'`);
    expect(split).toEqual({ segments: [`echo "a; b"`, `echo 'c | d'`], opaque: false });
  });

  it("does not split fd redirections or pipes into files", () => {
    expect(splitShellCommand("cmd 2>&1 | tail").segments).toEqual(["cmd 2>&1", "tail"]);
  });

  it("marks substitutions, subshells, braces and heredocs opaque", () => {
    expect(splitShellCommand("echo $(date)")).toEqual({ segments: ["echo $(date)"], opaque: true });
    expect(splitShellCommand("echo `date`")).toEqual({ segments: ["echo `date`"], opaque: true });
    expect(splitShellCommand("(cd x && ls)").opaque).toBe(true);
    expect(splitShellCommand("echo {a,b}").opaque).toBe(true);
    expect(splitShellCommand("cat <<EOF").opaque).toBe(true);
  });

  it("marks an unterminated quote opaque instead of guessing", () => {
    expect(splitShellCommand(`echo "x`)).toEqual({ segments: [`echo "x`], opaque: true });
  });

  it("drops comments but keeps the next line", () => {
    expect(splitShellCommand("npm test # quick check\nnpm run build")).toEqual({
      segments: ["npm test", "npm run build"],
      opaque: false,
    });
    expect(splitShellCommand("# only a comment")).toEqual({ segments: ["# only a comment"], opaque: true });
  });
});

describe("normalizeRuleValue", () => {
  it("compares file paths with forward slashes on every OS", () => {
    expect(normalizeRuleValue("write_file", "src\\app.ts")).toBe("src/app.ts");
    expect(normalizeRuleValue("bash", "src\\app.ts")).toBe("src\\app.ts");
  });
});
