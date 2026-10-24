import { afterEach, describe, expect, it } from "vitest";
import type { ImageBlockParam, MessageParam } from "../src/types.js";
import {
  enforceSessionMediaBudget,
  imageByteSize,
  imageMaxEdge,
  mediaLimits,
  validateImages,
} from "../src/mediaBudget.js";

function img(kb: number): ImageBlockParam {
  // base64 → decoded bytes = len*3/4; 1KB of base64 ≈ 768 bytes decoded.
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "A".repeat(kb * 1024) },
  } as ImageBlockParam;
}

afterEach(() => {
  delete process.env.AGENT_MAX_IMAGES_PER_MESSAGE;
  delete process.env.AGENT_MAX_IMAGE_BYTES;
  delete process.env.AGENT_MAX_SESSION_IMAGES;
  delete process.env.AGENT_IMAGE_MAX_EDGE;
});

describe("mediaLimits", () => {
  it("defaults and env overrides", () => {
    expect(mediaLimits()).toEqual({ perMessage: 5, perImageBytes: 5 * 1024 * 1024, sessionImages: 20 });
    process.env.AGENT_MAX_IMAGES_PER_MESSAGE = "2";
    process.env.AGENT_MAX_SESSION_IMAGES = "3";
    const l = mediaLimits();
    expect(l.perMessage).toBe(2);
    expect(l.sessionImages).toBe(3);
  });

  it("ignores non-positive env values", () => {
    process.env.AGENT_MAX_SESSION_IMAGES = "0";
    expect(mediaLimits().sessionImages).toBe(20);
  });
});

describe("imageMaxEdge", () => {
  it("defaults to 1568 and honors explicit / zero / invalid values", () => {
    expect(imageMaxEdge(undefined)).toBe(1568);
    expect(imageMaxEdge("")).toBe(1568);
    expect(imageMaxEdge("512")).toBe(512);
    expect(imageMaxEdge("0")).toBe(0);
    expect(imageMaxEdge("abc")).toBe(1568);
    expect(imageMaxEdge("-8")).toBe(1568);
  });

  it("reads the environment at call time", () => {
    process.env.AGENT_IMAGE_MAX_EDGE = "640";
    expect(imageMaxEdge()).toBe(640);
  });
});

describe("imageByteSize", () => {
  it("computes decoded size from base64 length", () => {
    expect(imageByteSize(img(4))).toBe(4 * 768);
  });
});

describe("validateImages", () => {
  it("passes within limits and on undefined", () => {
    expect(() => validateImages(undefined, mediaLimits())).not.toThrow();
    expect(() => validateImages([img(1), img(1)], mediaLimits())).not.toThrow();
  });

  it("rejects over-count with the limit named", () => {
    process.env.AGENT_MAX_IMAGES_PER_MESSAGE = "2";
    expect(() => validateImages([img(1), img(1), img(1)], mediaLimits())).toThrow(/limit 2 per message/);
  });

  it("rejects oversized images", () => {
    process.env.AGENT_MAX_IMAGE_BYTES = "1024";
    expect(() => validateImages([img(4)], mediaLimits())).toThrow(/image too large/);
  });
});

describe("enforceSessionMediaBudget", () => {
  it("is a no-op under the cap", () => {
    const messages: MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "hi" }, img(1)] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    expect(enforceSessionMediaBudget(messages, mediaLimits())).toBe(0);
    expect((messages[0].content as ImageBlockParam[])[1].type).toBe("image");
  });

  it("elides oldest images first across messages, including tool_result images", () => {
    process.env.AGENT_MAX_SESSION_IMAGES = "1";
    const limits = mediaLimits();
    const messages: MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "m0" }, img(1), img(1)] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [img(1)] },
        ],
      },
      { role: "user", content: [{ type: "text", text: "m2" }, img(1)] },
    ];
    // 4 live images, cap 1: the oldest three go (both of m0, then tool_result).
    const removed = enforceSessionMediaBudget(messages, limits);
    expect(removed).toBe(3);
    const c0 = messages[0].content as Array<Record<string, unknown>>;
    expect(c0[1]).toEqual({ type: "text", text: "[image removed: session media budget]" });
    expect(c0[2]).toEqual({ type: "text", text: "[image removed: session media budget]" });
    const tr = (messages[1].content as Array<Record<string, unknown>>)[0];
    expect((tr.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "text",
      text: "[image removed: session media budget]",
    });
    // Newest image survives.
    expect((messages[2].content as ImageBlockParam[])[1].type).toBe("image");
  });

  it("handles string contents and non-array blocks safely", () => {
    process.env.AGENT_MAX_SESSION_IMAGES = "1";
    const messages: MessageParam[] = [
      { role: "user", content: "plain string" },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ];
    expect(enforceSessionMediaBudget(messages, mediaLimits())).toBe(0);
  });
});
