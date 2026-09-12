import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  ansiHelpers,
  ansiPaint,
  detectBackgroundFromEnv,
  getTheme,
  luminanceFromRgb,
  markdownTerminalOptions,
  parseThemeName,
  resolveTheme,
  resolveThemeAsync,
  saveTheme,
  ThemeContext,
  THEME_NAMES,
  type Theme,
} from "../src/ui/theme.js";
import { loadConfigFiles } from "../src/llm.js";
import { parseAnsi } from "../src/ui/ansi.js";
import { Markdown, toAnsi } from "../src/ui/markdown.js";

const dirs: string[] = [];
async function tmpdir(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

async function seedConfig(root: string, obj: unknown) {
  await fs.mkdir(path.join(root, ".node-agent"), { recursive: true });
  await fs.writeFile(path.join(root, ".node-agent", "config.json"), JSON.stringify(obj), "utf8");
}

describe("parseThemeName", () => {
  it("accepts the three themes case-insensitively", () => {
    expect(parseThemeName("dark")).toBe("dark");
    expect(parseThemeName("Light")).toBe("light");
    expect(parseThemeName(" AUTO ")).toBe("auto");
  });

  it("rejects anything else (so callers can print a useful error)", () => {
    expect(parseThemeName("purple")).toBeNull();
    expect(parseThemeName("")).toBeNull();
    expect(parseThemeName(undefined)).toBeNull();
  });
});

describe("palettes", () => {
  const tokens: Array<keyof Theme> = [
    "user", "toolRunning", "toolOk", "toolError", "border", "borderWarn", "borderDanger",
    "accent", "warn", "error", "success", "plan", "diffAdd", "diffDel", "diffMeta",
    "todoDone", "todoActive", "todoPending",
  ];

  it("every token is a concrete hex colour (no named colours to resolve)", () => {
    for (const id of ["dark", "light"] as const) {
      const theme = getTheme(id);
      for (const t of tokens) expect(String(theme[t]), `${id}.${String(t)}`).toMatch(/^#[0-9a-f]{6}$/);
      for (const [k, v] of Object.entries(theme.md)) expect(v, `${id}.md.${k}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("light is not just dark with the lights on — the pairs actually differ", () => {
    const dark = getTheme("dark");
    const light = getTheme("light");
    const differing = tokens.filter((t) => dark[t] !== light[t]);
    expect(differing.length).toBeGreaterThan(tokens.length / 2);
    // Muted greys flip direction: light borders are darker than light text.
    expect(dark.user).not.toBe(light.user);
  });
});

describe("detectBackgroundFromEnv", () => {
  it("reads COLORFGBG as fg;bg (last field is the background)", () => {
    expect(detectBackgroundFromEnv({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectBackgroundFromEnv({ COLORFGBG: "0;15" })).toBe("light");
    expect(detectBackgroundFromEnv({ COLORFGBG: "7;8" })).toBe("dark");
  });

  it("returns null when there is no usable hint", () => {
    expect(detectBackgroundFromEnv({})).toBeNull();
    expect(detectBackgroundFromEnv({ COLORFGBG: "default;default" })).toBeNull();
  });

  it("AGENT_BACKGROUND is an explicit escape hatch for auto", () => {
    expect(detectBackgroundFromEnv({ AGENT_BACKGROUND: "light", COLORFGBG: "15;0" })).toBe("light");
  });
});

describe("luminanceFromRgb", () => {
  it("classifies white as light and black as dark", () => {
    expect(luminanceFromRgb("ff", "ff", "ff")).toBeGreaterThan(128);
    expect(luminanceFromRgb("00", "00", "00")).toBeLessThan(128);
  });

  it("handles the 16-bit channels OSC 11 actually returns", () => {
    expect(luminanceFromRgb("ffff", "ffff", "ffff")).toBeGreaterThan(128);
    expect(luminanceFromRgb("0000", "0000", "0000")).toBeLessThan(128);
  });
});

describe("resolveTheme layering", () => {
  it("explicit option beats everything", () => {
    const r = resolveTheme({ theme: "light", env: { AGENT_THEME: "dark" } });
    expect(r.name).toBe("light");
    expect(r.theme.id).toBe("light");
    expect(r.source).toBe("cli");
  });

  it("AGENT_THEME beats the config files", async () => {
    const home = await tmpdir("th-home-");
    await seedConfig(home, { theme: "light" });
    const r = resolveTheme({ env: { AGENT_THEME: "dark" }, home, cwd: home });
    expect(r.name).toBe("dark");
    expect(r.source).toBe("env");
  });

  it("project config beats the global one", async () => {
    const home = await tmpdir("th-home-");
    const project = await tmpdir("th-proj-");
    await seedConfig(home, { theme: "dark" });
    await seedConfig(project, { theme: "light" });
    const r = resolveTheme({ env: {}, home, cwd: project });
    expect(r.theme.id).toBe("light");
    expect(r.source).toBe("project");
  });

  it("falls back to the global file, then to auto", async () => {
    const home = await tmpdir("th-home-");
    const project = await tmpdir("th-proj-");
    await seedConfig(home, { theme: "light" });
    expect(resolveTheme({ env: {}, home, cwd: project }).source).toBe("global");

    const bare = await tmpdir("th-bare-");
    const auto = resolveTheme({ env: {}, home: bare, cwd: bare });
    expect(auto.name).toBe("auto");
    expect(auto.source).toBe("detected");
    expect(auto.theme.id).toBe("dark"); // no hint anywhere → dark
  });

  it("auto without a TTY resolves promptly instead of hanging", async () => {
    const bare = await tmpdir("th-bare-");
    const r = await resolveThemeAsync({ env: { COLORFGBG: "0;15" }, home: bare, cwd: bare }, 50);
    expect(r.theme.id).toBe("light");
  });
});

describe("markdown palette", () => {
  it("produces SGR-wrapped text our <Ansi> renderer understands", () => {
    const md = markdownTerminalOptions(getTheme("dark"));
    const styled = (md.code as (s: string) => string)("x");
    expect(styled).toContain("x");
    expect(styled).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m/);
    expect(styled.endsWith("\x1b[0m")).toBe(true);
  });

  it("composes modifiers the way marked-terminal chains chalk", () => {
    const md = markdownTerminalOptions(getTheme("light"));
    // `heading` is built as hex(…).bold — the modifier must survive in the SGR.
    const heading = (md.heading as (s: string) => string)("Title");
    expect(heading).toMatch(/^\x1b\[38;2;\d+;\d+;\d+;1mTitle\x1b\[0m$/);
    const first = (md.firstHeading as (s: string) => string)("H1");
    expect(first).toMatch(/;4;1mH1/); // underline + bold, in chalk's chaining order
  });

  it("swaps colours with the theme", () => {
    const dark = markdownTerminalOptions(getTheme("dark"));
    const light = markdownTerminalOptions(getTheme("light"));
    expect((dark.code as (s: string) => string)("x")).not.toBe((light.code as (s: string) => string)("x"));
  });
});

describe("saveTheme", () => {
  it("merges into the global config instead of clobbering credentials", async () => {
    const home = await tmpdir("th-home-");
    const project = await tmpdir("th-proj-");
    await seedConfig(home, { provider: "anthropic", apiKey: "sk-secret", model: "claude-sonnet-4-5" });
    const { file, shadowed } = await saveTheme("light", { home, cwd: project });
    expect(file).toBe(path.join(home, ".node-agent", "config.json"));
    expect(shadowed).toBe(false);

    const cfg = loadConfigFiles(project, home);
    expect(cfg.theme).toBe("light");
    expect(cfg.apiKey).toBe("sk-secret");
    expect(cfg.model).toBe("claude-sonnet-4-5");
  });

  it("creates the file (and directory) when it does not exist yet", async () => {
    const home = await tmpdir("th-home-");
    const { file } = await saveTheme("dark", { home, cwd: home });
    const raw = await fs.readFile(file, "utf8");
    expect(JSON.parse(raw).theme).toBe("dark");
  });

  it("flags when a project-level theme shadows the global write", async () => {
    const home = await tmpdir("th-home-");
    const project = await tmpdir("th-proj-");
    await seedConfig(project, { theme: "dark" });
    const { shadowed } = await saveTheme("light", { home, cwd: project });
    expect(shadowed).toBe(true);
  });

  it("can write to the project scope instead", async () => {
    const home = await tmpdir("th-home-");
    const project = await tmpdir("th-proj-");
    const { file } = await saveTheme("auto", { home, cwd: project, scope: "project" });
    expect(file).toBe(path.join(project, ".node-agent", "config.json"));
    expect(loadConfigFiles(project, home).theme).toBe("auto");
  });

  it("refuses to overwrite an existing config that is not valid JSON", async () => {
    const home = await tmpdir("th-home-");
    await fs.mkdir(path.join(home, ".node-agent"), { recursive: true });
    const file = path.join(home, ".node-agent", "config.json");
    const corrupt = '{ "apiKey": "sk-secret", }'; // trailing comma → unparseable
    await fs.writeFile(file, corrupt, "utf8");

    await expect(saveTheme("light", { home, cwd: home })).rejects.toThrow(/not valid JSON/);
    // The original bytes survive — we never clobber a hand-corrupted config.
    expect(await fs.readFile(file, "utf8")).toBe(corrupt);
  });
});

describe("print-mode helpers", () => {
  it("paints with the palette's own colour", () => {
    const light = getTheme("light");
    const painted = ansiPaint(light.error, "boom");
    expect(painted).toContain("boom");
    expect(painted).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
  });

  it("each helper is themed, not hardcoded ANSI", () => {
    const dark = ansiHelpers(getTheme("dark"));
    const light = ansiHelpers(getTheme("light"));
    expect(dark.warn("x")).not.toBe(light.warn("x"));
    expect(dark.dim("x")).toBe(light.dim("x")); // structural styles stay put
  });
});

describe("end-to-end: markdown → SGR → <Ansi>", () => {
  const colorsOf = (md: string, theme: Theme) =>
    parseAnsi(toAnsi(md, theme)).filter((s) => s.style.color).map((s) => s.style.color);

  it("round-trips the themed colour through our own parser", () => {
    const light = toAnsi("`code`", getTheme("light"));
    const dark = toAnsi("`code`", getTheme("dark"));
    expect(light).not.toBe(dark);
    expect(colorsOf("`code`", getTheme("light"))).toContain(getTheme("light").md.codespan);
  });

  it("does not leak the previous theme into the shared marked singleton", () => {
    // marked.use mutates a module-level singleton — switching must re-apply.
    expect(colorsOf("`c`", getTheme("dark"))).toContain(getTheme("dark").md.codespan);
    expect(colorsOf("`c`", getTheme("light"))).toContain(getTheme("light").md.codespan);
    expect(colorsOf("`c`", getTheme("dark"))).toContain(getTheme("dark").md.codespan);
  });

  it("headings are styled (first heading may use its own colour) and bolded", () => {
    const dark = getTheme("dark");
    const colors = colorsOf("# A\n\n## B", dark);
    expect(colors.length).toBeGreaterThan(0);
    // marked-terminal uses `firstHeading` for the first one, `heading` after.
    for (const c of colors) expect([dark.md.heading, dark.md.firstHeading]).toContain(c);
    const bolded = parseAnsi(toAnsi("# A", dark)).find((s) => s.style.bold);
    expect(bolded?.style.bold).toBe(true);
  });
});

describe("React wiring", () => {
  const tree = (theme: Theme | null) =>
    theme
      ? React.createElement(ThemeContext.Provider, { value: theme }, React.createElement(Markdown, { text: "`wired`" }))
      : React.createElement(Markdown, { text: "`wired`" });

  it("renders under an explicit theme", () => {
    const { lastFrame } = render(tree(getTheme("light")));
    expect(lastFrame()).toContain("wired");
  });

  it("still renders with no provider (context falls back to dark)", () => {
    const { lastFrame } = render(tree(null));
    expect(lastFrame()).toContain("wired");
  });
});

describe("THEME_NAMES", () => {
  it("is exactly the documented trio", () => {
    expect(THEME_NAMES).toEqual(["dark", "light", "auto"]);
  });
});
