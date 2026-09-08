import React, { useMemo } from "react";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { Ansi } from "./ansi.js";

let renderer: unknown;

function getMarked(): typeof marked {
  if (!renderer) {
    renderer = markedTerminal({
      showSectionPrefix: false,
      reflowText: false,
    });
  }
  // markedTerminal() returns { renderer, useNewRenderer }; marked.use accepts it as-is.
  return marked.use(renderer as never);
}

/** Render a markdown string to ANSI-colored terminal text. */
export function toAnsi(markdown: string): string {
  try {
    return getMarked().parse(markdown) as string;
  } catch {
    return markdown;
  }
}

export function Markdown({ text }: { text: string }) {
  const ansi = useMemo(() => toAnsi(text), [text]);
  return <Ansi text={ansi} />;
}
