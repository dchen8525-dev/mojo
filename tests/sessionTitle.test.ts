import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TITLE_CHARS,
  MAX_TITLE_INPUT,
  buildTitlePrompt,
  cleanGeneratedTitle,
  disableSessionTitles,
  enableSessionTitlesForTests,
  generateSessionTitle,
  normalizeTitleInput,
  sessionTitlesEnabled,
} from "../src/sessionTitle.js";

describe("cleanGeneratedTitle", () => {
  it("extracts the requested JSON shape", () => {
    expect(cleanGeneratedTitle('{"title":"修复登录重定向"}')).toBe("修复登录重定向");
  });

  it("extracts fenced JSON even with surrounding prose", () => {
    expect(cleanGeneratedTitle('Sure:\n```json\n{"title": "Fix login redirect"}\n```\n')).toBe("Fix login redirect");
  });

  it("falls back to the first non-empty line for non-JSON replies", () => {
    expect(cleanGeneratedTitle("\n\n## 重构权限模块\nmore text").toString()).toBe("重构权限模块");
  });

  it("strips thinking blocks, quotes and trailing punctuation", () => {
    expect(cleanGeneratedTitle('<think>hidden</think>\n"补充缓存测试。"')).toBe("补充缓存测试");
  });

  it("rejects empty or symbol-only titles", () => {
    expect(cleanGeneratedTitle("")).toBeNull();
    expect(cleanGeneratedTitle("   \n  ")).toBeNull();
    expect(cleanGeneratedTitle("...?!")).toBeNull();
    expect(cleanGeneratedTitle('{"title":"   "}')).toBeNull();
  });

  it("elides titles past the display cap", () => {
    const long = "x".repeat(MAX_TITLE_CHARS + 50);
    const title = cleanGeneratedTitle(long)!;
    expect(title.length).toBe(MAX_TITLE_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("buildTitlePrompt", () => {
  it("refuses inputs too short to describe intent", () => {
    expect(buildTitlePrompt("hi")).toBeNull();
    expect(buildTitlePrompt("修一下")).toBeNull();
  });

  it("bounds and flattens the input sent to the model", () => {
    const prompt = buildTitlePrompt(`line one\n\n${"y".repeat(MAX_TITLE_INPUT * 2)}`)!;
    expect(prompt).not.toBeNull();
    const input = prompt.user.split('"""')[1].trim();
    expect(input).not.toContain("\n");
    expect(input.length).toBe(MAX_TITLE_INPUT);
    expect(prompt.system).toContain('{"title"');
  });

  it("normalizeTitleInput collapses whitespace and trims", () => {
    expect(normalizeTitleInput("  a \n\t b  ")).toBe("a b");
  });
});

describe("generateSessionTitle", () => {
  it("returns a cleaned title plus usage", async () => {
    const calls: Array<{ messages: unknown; tools: unknown }> = [];
    const llm = {
      send: async (messages: unknown, _system: string, tools: unknown) => {
        calls.push({ messages, tools });
        return {
          content: [{ type: "text", text: '{"title":"为会话自动命名"}' }],
          inputTokens: 42,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      },
    };
    const res = await generateSessionTitle(llm as never, "请给这个会话自动生成一个标题");
    expect(res).not.toBeNull();
    expect(res!.title).toBe("为会话自动命名");
    expect(res!.usage).toEqual({ input: 42, output: 7, cacheRead: 0, cacheWrite: 0 });
    expect(calls[0].tools).toEqual([]);
  });

  it("skips the model call entirely for short inputs", async () => {
    let called = false;
    const llm = { send: async () => ((called = true), {} as never) };
    expect(await generateSessionTitle(llm as never, "hi")).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when the reply carries no usable title", async () => {
    const llm = {
      send: async () => ({
        content: [{ type: "text", text: "...?!" }],
        inputTokens: 5,
        outputTokens: 1,
      }),
    };
    expect(await generateSessionTitle(llm as never, "请为我生成一下这个会话标题")).toBeNull();
  });
});

describe("session title switch", () => {
  afterEach(() => {
    delete process.env.AGENT_SESSION_TITLES;
    disableSessionTitles();
  });

  it("is off under vitest unless explicitly enabled, and obeys the env opt-out", () => {
    expect(sessionTitlesEnabled()).toBe(false);
    enableSessionTitlesForTests();
    expect(sessionTitlesEnabled()).toBe(true);
    process.env.AGENT_SESSION_TITLES = "0";
    expect(sessionTitlesEnabled()).toBe(false);
    delete process.env.AGENT_SESSION_TITLES;
    expect(sessionTitlesEnabled()).toBe(true);
    disableSessionTitles();
    expect(sessionTitlesEnabled()).toBe(false);
  });
});
