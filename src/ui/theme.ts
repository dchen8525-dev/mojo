import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import type { Config } from "../llm.js";
import { loadConfigLayers } from "../llm.js";

/**
 * Three themes: `dark`, `light`, and `auto` (follow the terminal background).
 *
 * A theme is a bag of *semantic* colors — the UI never hardcodes "green" or
 * "cyan" again, it asks for `toolOk` / `accent` / `diffAdd`. Adding a fourth
 * theme later means adding one palette object, not touching the components.
 */

export type ThemeName = "dark" | "light" | "auto";
/** What `auto` collapses into once the terminal background is known. */
export type ResolvedThemeName = "dark" | "light";
export const THEME_NAMES: ThemeName[] = ["dark", "light", "auto"];

export interface MarkdownPalette {
  code: string;
  blockquote: string;
  heading: string;
  firstHeading: string;
  codespan: string;
  link: string;
  href: string;
  html: string;
}

export interface Theme {
  id: ResolvedThemeName;
  user: string;
  toolRunning: string;
  toolOk: string;
  toolError: string;
  border: string;
  borderWarn: string;
  borderDanger: string;
  accent: string;
  warn: string;
  error: string;
  success: string;
  plan: string;
  diffAdd: string;
  diffDel: string;
  diffMeta: string;
  todoDone: string;
  todoActive: string;
  todoPending: string;
  md: MarkdownPalette;
}

const DARK: Theme = {
  id: "dark",
  user: "#7ee787",
  toolRunning: "#56d4dd",
  toolOk: "#3fb950",
  toolError: "#f85149",
  border: "#6e7681",
  borderWarn: "#d29922",
  borderDanger: "#f85149",
  accent: "#56d4dd",
  warn: "#d29922",
  error: "#f85149",
  success: "#3fb950",
  plan: "#d2a8ff",
  diffAdd: "#3fb950",
  diffDel: "#f85149",
  diffMeta: "#56d4dd",
  todoDone: "#3fb950",
  todoActive: "#d29922",
  todoPending: "#8b949e",
  md: {
    code: "#e3b341",
    blockquote: "#8b949e",
    heading: "#7ee787",
    firstHeading: "#d2a8ff",
    codespan: "#e3b341",
    link: "#58a6ff",
    href: "#58a6ff",
    html: "#8b949e",
  },
};

const LIGHT: Theme = {
  id: "light",
  user: "#1a7f37",
  toolRunning: "#0969da",
  toolOk: "#1a7f37",
  toolError: "#cf222e",
  border: "#8c959f",
  borderWarn: "#9a6700",
  borderDanger: "#cf222e",
  accent: "#0969da",
  warn: "#9a6700",
  error: "#cf222e",
  success: "#1a7f37",
  plan: "#8250df",
  diffAdd: "#1a7f37",
  diffDel: "#cf222e",
  diffMeta: "#0969da",
  todoDone: "#1a7f37",
  todoActive: "#9a6700",
  todoPending: "#8c959f",
  md: {
    code: "#953800",
    blockquote: "#6e7781",
    heading: "#116329",
    firstHeading: "#8250df",
    codespan: "#953800",
    link: "#0969da",
    href: "#0969da",
    html: "#6e7781",
  },
};

const THEMES: Record<ResolvedThemeName, Theme> = { dark: DARK, light: LIGHT };

export function getTheme(id: ResolvedThemeName): Theme {
  return THEMES[id];
}

/* ---------------- React plumbing ---------------- */

/**
 * `/theme` switches palettes from the CLI layer; the Ink tree reads the
 * current one from this context so every component re-renders on a switch.
 */
export const ThemeContext = React.createContext<Theme>(DARK);
export function useTheme(): Theme {
  return React.useContext(ThemeContext);
}

/** Accepts "dark" / "Light" / "AUTO"; anything else is null (caller reports). */
export function parseThemeName(value: string | undefined | null): ThemeName | null {
  if (!value) return null;
  const s = value.trim().toLowerCase();
  return (THEME_NAMES as string[]).includes(s) ? (s as ThemeName) : null;
}

/* ---------------- terminal background detection ---------------- */

/**
 * Cheap synchronous hint: `COLORFGBG` is exported by many terminals as
 * "<fg>;<bg>" using ANSI colour indices — a low index (0-6, 8) means the
 * background is dark, 7 or 9-15 means it is light.
 */
export function detectBackgroundFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedThemeName | null {
  const explicit = parseThemeName(env.AGENT_BACKGROUND);
  if (explicit && explicit !== "auto") return explicit;
  const raw = env.COLORFGBG;
  if (!raw) return null;
  const parts = raw.split(";").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const bg = Number(parts[parts.length - 1]);
  if (!Number.isFinite(bg)) return null;
  if (bg >= 0 && bg <= 6) return "dark";
  if (bg === 8) return "dark";
  if (bg === 7 || (bg >= 9 && bg <= 15)) return "light";
  return null;
}

function channelTo255(hex: string): number {
  const v = parseInt(hex, 16);
  if (!Number.isFinite(v)) return 0;
  return hex.length <= 2 ? v : Math.round((v / (16 ** hex.length - 1)) * 255);
}

/** Relative luminance (0-255) of an `rgb:`/`rgba:` OSC 11 response. */
export function luminanceFromRgb(r: string, g: string, b: string): number {
  const R = channelTo255(r);
  const G = channelTo255(g);
  const B = channelTo255(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

const OSC11_RE = /\x1b\]11;(?:rgba?|RGBA?):([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/;

/**
 * Ask the terminal for its background colour (OSC 11) and resolve a theme.
 * Returns null when the terminal cannot answer (not a TTY, conhost, timeout),
 * so callers fall back to the env hint and finally to `dark`.
 *
 * Must run *before* the Ink UI takes over stdin.
 */
export function detectBackgroundAsync(timeoutMs = 300): Promise<ResolvedThemeName | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin as unknown as {
      isTTY?: boolean;
      isRaw?: boolean;
      setRawMode?: (v: boolean) => void;
      on?: (e: string, fn: (buf: Buffer | string) => void) => void;
      removeListener?: (e: string, fn: (buf: Buffer | string) => void) => void;
      resume?: () => void;
      pause?: () => void;
    };
    const stdout = process.stdout as unknown as { isTTY?: boolean; write?: (s: string) => unknown };
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
      resolve(null);
      return;
    }

    let settled = false;
    const prevRaw = stdin.isRaw === true;
    const onData = (buf: Buffer | string) => {
      const s = typeof buf === "string" ? buf : buf.toString("utf8");
      const m = OSC11_RE.exec(s);
      if (!m) return;
      finish(luminanceFromRgb(m[1], m[2], m[3]) >= 128 ? "light" : "dark");
    };
    const finish = (value: ResolvedThemeName | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        stdin.removeListener?.("data", onData);
      } catch {
        /* ignore */
      }
      try {
        stdin.setRawMode?.(prevRaw);
      } catch {
        /* ignore */
      }
      try {
        stdin.pause?.();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      stdin.setRawMode?.(true);
      stdin.resume?.();
      stdin.on?.("data", onData);
      stdout.write?.("\x1b]11;?\x1b\\");
    } catch {
      finish(null);
    }
  });
}

/* ---------------- resolution / layering ---------------- */

export interface ThemeResolution {
  /** The configured name (what the user asked for, possibly "auto"). */
  name: ThemeName;
  /** The concrete theme in effect. */
  theme: Theme;
  /** Where `name` came from — surfaced by `/theme` with no arguments. */
  source: "cli" | "env" | "project" | "global" | "default" | "detected";
}

export interface ResolveThemeOptions {
  /** Explicit override (CLI `--theme` lands here via AGENT_THEME). */
  theme?: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  config?: Config;
}

function pickName(opts: ResolveThemeOptions): { name: ThemeName; source: ThemeResolution["source"] } {
  const env = opts.env ?? process.env;
  const fromArg = parseThemeName(opts.theme);
  if (fromArg) return { name: fromArg, source: "cli" };
  const fromEnv = parseThemeName(env.AGENT_THEME);
  if (fromEnv) return { name: fromEnv, source: "env" };
  if (opts.config) {
    const fromConfig = parseThemeName(opts.config.theme);
    if (fromConfig) return { name: fromConfig, source: "project" };
  }
  const layers = loadConfigLayers(opts.cwd ?? process.cwd(), opts.home ?? os.homedir());
  const fromProject = parseThemeName(layers.project.theme);
  if (fromProject) return { name: fromProject, source: "project" };
  const fromGlobal = parseThemeName(layers.global.theme);
  if (fromGlobal) return { name: fromGlobal, source: "global" };
  return { name: "auto", source: "default" };
}

/**
 * Synchronous resolution: `auto` falls back to the COLORFGBG hint (or
 * AGENT_BACKGROUND), then to `dark`. Use `resolveThemeAsync` when a TTY is
 * available and you can afford the OSC 11 round-trip.
 */
export function resolveTheme(opts: ResolveThemeOptions = {}): ThemeResolution {
  const { name, source } = pickName(opts);
  if (name !== "auto") return { name, theme: getTheme(name), source };
  const detected = detectBackgroundFromEnv(opts.env ?? process.env) ?? "dark";
  return { name, theme: getTheme(detected), source: "detected" };
}

/** Like `resolveTheme`, but asks the terminal first when the name is `auto`. */
export async function resolveThemeAsync(opts: ResolveThemeOptions = {}, timeoutMs = 300): Promise<ThemeResolution> {
  const { name, source } = pickName(opts);
  if (name !== "auto") return { name, theme: getTheme(name), source };
  const asked = await detectBackgroundAsync(timeoutMs);
  const detected = asked ?? detectBackgroundFromEnv(opts.env ?? process.env) ?? "dark";
  return { name, theme: getTheme(detected), source: "detected" };
}

/* ---------------- persistence ---------------- */

/**
 * Persist a theme choice so the next session starts with it. Writes to the
 * global config by default (a theme is a personal preference); merges into the
 * existing file so apiKey/model survive. Throws instead of overwriting when the
 * file exists but is not valid JSON — otherwise a hand-corrupted config would
 * be replaced by `{theme}` alone and silently lose apiKey/model.
 */
export async function saveTheme(
  name: ThemeName,
  opts: { cwd?: string; home?: string; scope?: "global" | "project" } = {},
): Promise<{ file: string; shadowed: boolean }> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const scope = opts.scope ?? "global";
  const file =
    scope === "project"
      ? path.join(cwd, ".node-agent", "config.json")
      : path.join(home, ".node-agent", "config.json");

  // A project-level theme shadows the global one, so warn instead of silently
  // writing somewhere that has no effect.
  let shadowed = false;
  if (scope === "global") {
    const projectCfg = readJsonSync(path.join(cwd, ".node-agent", "config.json"));
    shadowed = typeof projectCfg === "object" && projectCfg !== null && Boolean(parseThemeName(projectCfg.theme));
  }

  const existing = readJsonSync(file);
  if (existing === "corrupt") {
    throw new Error(`${file} exists but is not valid JSON — fix it before saving the theme (refused to overwrite)`);
  }
  const next = { ...(existing ?? {}), theme: name };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { file, shadowed };
}

/** Parsed config; `null` when the file is absent, `"corrupt"` when it exists but won't parse. */
function readJsonSync(file: string): (Config & Record<string, unknown>) | null | "corrupt" {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null; // no file yet
  }
  try {
    // Strip a leading UTF-8 BOM so Windows-edited configs still parse.
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as Config & Record<string, unknown>;
  } catch {
    return "corrupt";
  }
}

/* ---------------- print-mode (-p) helpers ---------------- */

/**
 * The `-p` path renders plain text with raw escape codes instead of Ink, so it
 * needs the palette as SGR strings rather than React props.
 */
export function ansiFg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function ansiPaint(hex: string, text: string): string {
  return `${ansiFg(hex)}${text}\x1b[0m`;
}

/** The `chalk`-ish helper bundle `-p` mode uses, derived from a theme. */
export function ansiHelpers(theme: Theme) {
  return {
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    accent: (s: string) => ansiPaint(theme.accent, s),
    success: (s: string) => ansiPaint(theme.toolOk, s),
    warn: (s: string) => ansiPaint(theme.warn, s),
    error: (s: string) => ansiPaint(theme.error, s),
    muted: (s: string) => ansiPaint(theme.todoPending, s),
  };
}

/* ---------------- marked-terminal palette ---------------- */

/** A chalk-compatible styler: callable, and composable via `.bold` etc. */
export type MarkdownStyle = ((text: string) => string) & { [modifier: string]: MarkdownStyle };

const MD_MODIFIERS: Record<string, number> = {
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
  strikethrough: 9,
};

function styleFn(codes: number[]): MarkdownStyle {
  const base = ((text: string) => `\x1b[${codes.join(";")}m${text}\x1b[0m`) as unknown as MarkdownStyle;
  return new Proxy(base, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "reset") return (((text: string) => String(text)) as unknown as MarkdownStyle);
      const code = MD_MODIFIERS[String(prop)];
      return code === undefined ? styleFn(codes) : styleFn([...codes, code]);
    },
  }) as MarkdownStyle;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

/**
 * Build the option object marked-terminal expects. It wants chalk instances,
 * which we approximate with tiny SGR wrappers — no extra dependency, and the
 * escape codes are already understood by our <Ansi> renderer.
 *
 * Note: marked-terminal takes these **top-level** (there is no `theme:` key),
 * so the caller spreads this straight into `markedTerminal({ ... })`.
 */
export function markdownTerminalOptions(theme: Theme): Record<string, unknown> {
  const hex = (value: string) => styleFn([38, 2, ...hexToRgb(value)]);
  const identity = ((text: string) => String(text)) as unknown as MarkdownStyle;
  return {
    code: hex(theme.md.code),
    codespan: hex(theme.md.codespan),
    blockquote: hex(theme.md.blockquote).italic,
    heading: hex(theme.md.heading).bold,
    firstHeading: hex(theme.md.firstHeading).underline.bold,
    link: hex(theme.md.link),
    href: hex(theme.md.href).underline,
    html: hex(theme.md.html),
    del: styleFn([2, 9]),
    hr: identity,
    table: identity,
    paragraph: identity,
    listitem: identity,
    text: identity,
  };
}
