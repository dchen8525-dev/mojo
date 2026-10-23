import { afterEach, describe, expect, it } from "vitest";
import { AUX_MAX_OUTPUT, auxiliarySendOptions } from "../src/auxiliary.js";

const ENV = "AGENT_AUX_MAX_OUTPUT";

afterEach(() => {
  delete process.env[ENV];
});

describe("auxiliarySendOptions", () => {
  it("caps output at 5k and disables thinking by default", () => {
    expect(auxiliarySendOptions()).toEqual({ maxOutput: AUX_MAX_OUTPUT, thinking: false });
    expect(AUX_MAX_OUTPUT).toBe(5000);
  });

  it("lets AGENT_AUX_MAX_OUTPUT raise the cap", () => {
    process.env[ENV] = "20000";
    expect(auxiliarySendOptions()).toEqual({ maxOutput: 20000, thinking: false });
  });

  it("ignores invalid or non-positive overrides", () => {
    process.env[ENV] = "abc";
    expect(auxiliarySendOptions().maxOutput).toBe(5000);
    process.env[ENV] = "0";
    expect(auxiliarySendOptions().maxOutput).toBe(5000);
    process.env[ENV] = "-5";
    expect(auxiliarySendOptions().maxOutput).toBe(5000);
  });
});
