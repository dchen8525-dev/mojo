import { describe, expect, it } from "vitest";
import { validateToolInput } from "../src/types.js";
import { looksBinary } from "../src/tools/read.js";
import { lookupModel } from "../src/llm/models.js";
import type Anthropic from "@anthropic-ai/sdk";

describe("validateToolInput", () => {
  const schema: Anthropic.Messages.Tool["input_schema"] = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer" },
      recursive: { type: "boolean" },
      tags: { type: "array" },
    },
    required: ["path"],
  };

  it("accepts valid input", () => {
    expect(validateToolInput(schema, { path: "x", limit: 5, tags: ["a"] })).toBeNull();
  });

  it("rejects a missing required field", () => {
    const err = validateToolInput(schema, { limit: 5 });
    expect(err).toContain("Missing required parameter \"path\"");
  });

  it("rejects a wrong primitive type", () => {
    const err = validateToolInput(schema, { path: "x", limit: "five" });
    expect(err).toContain("must be integer");
    expect(err).toContain("got string");
  });

  it("ignores unknown keys and extra values", () => {
    expect(validateToolInput(schema, { path: "x", nope: 123 })).toBeNull();
  });

  it("returns null when the schema declares no properties", () => {
    expect(validateToolInput({ type: "object" }, { anything: true })).toBeNull();
    expect(validateToolInput(undefined, {})).toBeNull();
  });
});

describe("looksBinary", () => {
  it("flags a NUL byte anywhere", () => {
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
  });

  it("flags dense control bytes without a NUL (e.g. some encodings)", () => {
    // 50% non-printing control bytes in the sample, no NUL.
    const bytes = [0x01, 0x02, 0x41, 0x03];
    expect(looksBinary(Buffer.from(bytes))).toBe(true);
  });

  it("accepts plain UTF-8 text", () => {
    expect(looksBinary(Buffer.from("hello world\nsecond line\n", "utf8"))).toBe(false);
  });

  it("accepts an empty buffer", () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });
});

describe("model vision capability", () => {
  it("flags Claude / GPT-4o as vision-capable", () => {
    expect(lookupModel("claude-sonnet-4-5").vision).toBe(true);
    expect(lookupModel("claude-3-5-sonnet").vision).toBe(true);
    expect(lookupModel("gpt-4o").vision).toBe(true);
  });

  it("leaves text-only / unknown models without vision", () => {
    expect(lookupModel("deepseek-chat").vision).toBeUndefined();
    expect(lookupModel("glm-4-plus").vision).toBeUndefined();
    expect(lookupModel("mystery-model").vision).toBeUndefined();
  });
});