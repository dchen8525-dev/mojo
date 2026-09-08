import React, { useMemo } from "react";
import { Box, Text } from "ink";

export interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const FG16 = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const FG16_BRIGHT = [
  "blackBright",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
];
const BASE16_HEX = [
  "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];
const CUBE = [0, 95, 135, 175, 215, 255];

function rgb(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function ansi256ToHex(n: number): string {
  if (n < 16) return BASE16_HEX[n];
  if (n >= 232) {
    const g = 8 + (n - 232) * 10;
    return rgb(g, g, g);
  }
  const i = n - 16;
  return rgb(CUBE[Math.floor(i / 36)], CUBE[Math.floor((i % 36) / 6)], CUBE[i % 6]);
}

function applySgr(style: AnsiStyle, params: string) {
  const codes = (params === "" ? [0] : params.split(";").map((x) => parseInt(x, 10) || 0)).slice();
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) {
      delete style.color;
      delete style.backgroundColor;
      style.bold = style.dim = style.italic = style.underline = style.inverse = false;
    } else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 7) style.inverse = true;
    else if (c === 22) style.bold = style.dim = false;
    else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c === 27) style.inverse = false;
    else if (c === 39) delete style.color;
    else if (c === 49) delete style.backgroundColor;
    else if (c >= 30 && c <= 37) style.color = FG16[c - 30];
    else if (c >= 90 && c <= 97) style.color = FG16_BRIGHT[c - 90];
    else if (c >= 40 && c <= 47) style.backgroundColor = FG16[c - 40];
    else if (c >= 100 && c <= 107) style.backgroundColor = FG16_BRIGHT[c - 100];
    else if (c === 38 && codes[i + 1] === 5) {
      style.color = ansi256ToHex(codes[i + 2] ?? 0);
      i += 2;
    } else if (c === 38 && codes[i + 1] === 2) {
      style.color = rgb(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
      i += 4;
    } else if (c === 48 && codes[i + 1] === 5) {
      style.backgroundColor = ansi256ToHex(codes[i + 2] ?? 0);
      i += 2;
    } else if (c === 48 && codes[i + 1] === 2) {
      style.backgroundColor = rgb(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
      i += 4;
    }
  }
}

/** Split ANSI-styled text into plain segments with ink-compatible styles. */
export function parseAnsi(input: string): AnsiSegment[] {
  // Strip OSC sequences (hyperlinks keep their text: OSC 8;;url BEL text OSC 8;; BEL)
  const text = input
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*[@-ln-~]/g, "") // non-SGR CSI (final byte @..~ except m); SGR kept
    .replace(/\r/g, "");

  const segments: AnsiSegment[] = [];
  const style: AnsiStyle = {};
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string) => {
    if (t) segments.push({ text: t, style: { ...style } });
  };
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index));
    applySgr(style, m[1]);
    last = re.lastIndex;
  }
  push(text.slice(last));
  return segments;
}

/** Split segments into lines (each segment may contain \n). */
export function splitLines(segments: AnsiSegment[]): AnsiSegment[][] {
  const out: AnsiSegment[][] = [[]];
  for (const seg of segments) {
    const parts = seg.text.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) out.push([]);
      if (p) out[out.length - 1].push({ text: p, style: seg.style });
    });
  }
  return out;
}

export function Ansi({ text }: { text: string }) {
  const lines = useMemo(() => splitLines(parseAnsi(text)), [text]);

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          {line.length === 0
            ? " "
            : line.map((s, j) => (
                <Text
                  key={j}
                  color={s.style.color}
                  backgroundColor={s.style.backgroundColor}
                  bold={s.style.bold}
                  dimColor={s.style.dim}
                  italic={s.style.italic}
                  underline={s.style.underline}
                  inverse={s.style.inverse}
                >
                  {s.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
