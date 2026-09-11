import React, { useMemo } from "react";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { Ansi } from "./ansi.js";
import { getTheme, markdownTerminalOptions, useTheme, type Theme } from "./theme.js";

/**
 * marked.apply is global, so we remember which palette is currently installed
 * and re-apply whenever the user switches themes (a plain cache would leave
 * the *first* theme's colors baked into the singleton forever).
 */
let instance: typeof marked | null = null;
let installedThemeId: string | null = null;

function getMarked(theme: Theme): typeof marked {
  if (!instance || installedThemeId !== theme.id) {
    instance = marked.use(
      markedTerminal({
        showSectionPrefix: false,
        reflowText: false,
        ...markdownTerminalOptions(theme),
      }) as never,
    );
    installedThemeId = theme.id;
  }
  return instance;
}

/** Render a markdown string to ANSI-colored terminal text. */
export function toAnsi(markdown: string, theme: Theme = getTheme("dark")): string {
  try {
    return getMarked(theme).parse(markdown) as string;
  } catch {
    return markdown;
  }
}

export function Markdown({ text }: { text: string }) {
  const theme = useTheme();
  const ansi = useMemo(() => toAnsi(text, theme), [text, theme]);
  return <Ansi text={ansi} />;
}
