import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { Agent, COMPACT_RATIO, type AgentEvents } from "../agent.js";
import type { PermissionManager } from "../permissions.js";
import type { ImageBlockParam, Risk, UserQuestionOutcome, UserQuestionRequest } from "../types.js";
import type { TodoItem } from "../tools/todo.js";
import { bridge } from "./bridge.js";
import { Markdown } from "./markdown.js";
import { ThemeContext, useTheme, type Theme } from "./theme.js";
import { clipCell, GUTTER, looksLikeDiff, splitColumnWidth, splitDiffRows } from "./splitDiff.js";
import { captureClipboardImage } from "../clipboard.js";
import { backgroundManager } from "../tools/background.js";
import { expandFileReferences, renderCommand, type SlashCommand } from "../commands.js";
import { goalSummaryLine } from "../goal.js";
import { sanitizeErrorMessage } from "../errorSanitizer.js";
import { imagePrepareLimits, prepareImagesForModel } from "../imageResize.js";
import {
  completeMention,
  filterMentionPaths,
  listWorkspacePaths,
  MENTION_VISIBLE_COUNT,
  resolveActiveMention,
  visibleMentionWindow,
  type MentionPath,
} from "../mentions.js";

interface ToolRow {
  id: string;
  name: string;
  preview: string;
  status: "running" | "ok" | "error";
  result?: string;
  round?: number;
}

type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; round?: number }
  | { kind: "tool"; row: ToolRow }
  | { kind: "system"; text: string };

interface PermissionRequest {
  description: string;
  risk: Risk;
  preview?: string;
  /** Structured rule saved by "always"/"project"/"session" answers. */
  rule?: string;
  resolve: (answer: "yes" | "no" | "session" | "project" | "always" | "always_deny") => void;
}

interface AskState {
  request: UserQuestionRequest;
  /** Question being shown; earlier ones are already answered. */
  index: number;
  selected: Set<string>[];
  resolve: (outcome: UserQuestionOutcome) => void;
}

const MAX_VISIBLE_TOOLS = 6;
const COLLAPSE_AFTER_LINES = 14; // assistant replies longer than this fold up
const COLLAPSE_HEAD_LINES = 10; // lines shown while folded
const DIFF_WINDOW = 30; // diff lines visible per page in the permission prompt

function ToolRowView({ row }: { row: ToolRow }) {
  const theme = useTheme();
  const icon = row.status === "running" ? "⚡" : row.status === "ok" ? "✓" : "✗";
  const color = row.status === "running" ? theme.toolRunning : row.status === "ok" ? theme.toolOk : theme.toolError;
  const resultLine = row.result ? row.result.split("\n")[0] : "";
  return (
    <Box>
      <Text color={color}>{`${icon} `}</Text>
      <Text bold>{row.name}</Text>
      <Text dimColor> {row.preview.slice(0, 80)}</Text>
      {resultLine && row.status !== "running" && <Text dimColor> — {resultLine.slice(0, 60)}</Text>}
    </Box>
  );
}

function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const theme = useTheme();
  if (!todos.length) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Text bold dimColor>
        Tasks
      </Text>
      {todos.map((t) => (
        <Text
          key={t.id}
          color={t.status === "completed" ? theme.todoDone : t.status === "in_progress" ? theme.todoActive : theme.todoPending}
        >
          {t.status === "completed" ? "[x] " : t.status === "in_progress" ? "[>] " : "[ ] "}
          {t.content}
        </Text>
      ))}
    </Box>
  );
}

function DiffPreview({ diff, page = 0, split, termCols }: { diff: string; page?: number; split: boolean; termCols: number }) {
  const theme = useTheme();
  const isDiff = looksLikeDiff(diff);
  const showSplit = split && isDiff;
  const tint = (l: string) =>
    l.startsWith("+") ? theme.diffAdd : l.startsWith("-") ? theme.diffDel : l.startsWith("@@") ? theme.diffMeta : undefined;

  if (showSplit) {
    const rows = splitDiffRows(diff);
    const start = page * DIFF_WINDOW;
    const windowRows = rows.slice(start, start + DIFF_WINDOW);
    const w = splitColumnWidth(termCols);
    const side = GUTTER + w;
    return (
      <Box flexDirection="column" marginTop={1}>
        {windowRows.map((r, i) =>
          r.kind === "meta" ? (
            <Text key={start + i} color={theme.diffMeta} wrap="truncate">
              {r.text}
            </Text>
          ) : (
            <Box key={start + i}>
              <Box width={side}>
                <Text dimColor>{r.left.num === null ? "   " : `${String(r.left.num).padStart(2)} `}</Text>
                <Text color={r.changed ? theme.diffDel : undefined} dimColor={!r.changed} wrap="truncate">
                  {clipCell(r.left.text, w)}
                </Text>
              </Box>
              <Box width={side}>
                <Text dimColor>{r.right.num === null ? "   " : `${String(r.right.num).padStart(2)} `}</Text>
                <Text color={r.changed ? theme.diffAdd : undefined} dimColor={!r.changed} wrap="truncate">
                  {clipCell(r.right.text, w)}
                </Text>
              </Box>
            </Box>
          ),
        )}
        <Text dimColor>
          split · rows {start + 1}-{Math.min(start + DIFF_WINDOW, rows.length)} / {rows.length} · PageUp/PageDown scroll · t = unified
        </Text>
      </Box>
    );
  }

  const lines = diff.split("\n");
  const start = page * DIFF_WINDOW;
  const windowLines = lines.slice(start, start + DIFF_WINDOW);
  return (
    <Box flexDirection="column" marginTop={1}>
      {windowLines.map((l, i) => (
        <Text
          key={start + i}
          color={tint(l)}
          dimColor={!l.startsWith("+") && !l.startsWith("-") && !l.startsWith("@@")}
          wrap="truncate"
        >
          {l}
        </Text>
      ))}
      <Text dimColor>
        {lines.length > DIFF_WINDOW ? `diff ${start + 1}-${Math.min(start + DIFF_WINDOW, lines.length)} / ${lines.length} lines · PageUp/PageDown to scroll` : ""}
        {isDiff ? `${lines.length > DIFF_WINDOW ? " · " : ""}t = split` : ""}
      </Text>
    </Box>
  );
}

function PermissionPrompt({ request, diffPage, diffSplit, termCols }: { request: PermissionRequest; diffPage: number; diffSplit: boolean; termCols: number }) {
  const theme = useTheme();
  const danger = request.risk === "high";
  const tone = danger ? theme.borderDanger : theme.borderWarn;
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={tone} paddingX={1}>
      <Text bold color={tone}>
        Permission required {danger ? "(high risk)" : "(write)"}
      </Text>
      <Text>{request.description}</Text>
      {request.preview && <DiffPreview diff={request.preview} page={diffPage} split={diffSplit} termCols={termCols} />}
      {request.rule && <Text dimColor>always saves: {request.rule}</Text>}
      <Text dimColor>
        y = allow once · s = allow this session · p = allow for project · a = always allow · d = always deny · n / Esc =
        deny once · t = toggle split diff
      </Text>
    </Box>
  );
}

function QuestionPrompt({ ask }: { ask: AskState }) {
  const theme = useTheme();
  const question = ask.request.questions[ask.index];
  const selected = ask.selected[ask.index] ?? new Set<string>();
  const total = ask.request.questions.length;
  const timeoutSecs = Math.round(ask.request.timeoutMs / 1000);
  const last = ask.index + 1 >= total;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        Question {ask.index + 1}/{total}
        {question.header ? <Text dimColor> · {question.header}</Text> : null}
      </Text>
      <Text>{question.question}</Text>
      {question.options.map((o, i) => {
        const active = selected.has(o.label);
        return (
          <Box key={o.label} flexDirection="column">
            <Text color={active ? theme.accent : undefined}>
              {active ? (question.multiSelect ? "[x] " : "(o) ") : question.multiSelect ? "[ ] " : "( ) "}
              {i + 1}. {o.label}
            </Text>
            {o.description && <Text dimColor>{"     " + o.description}</Text>}
          </Box>
        );
      })}
      <Text dimColor>
        1-4 select{question.multiSelect ? " (multi)" : ""} · Enter {last ? "submit" : "next"} · Esc skip · {timeoutSecs}s
        timeout
      </Text>
    </Box>
  );
}

function TranscriptView({ items, expandedAll }: { items: TranscriptItem[]; expandedAll: boolean }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        if (item.kind === "user")
          return (
            <Box key={i} marginBottom={1}>
              <Text color={theme.user} bold>
                {"❯ "}
              </Text>
              <Text>{item.text}</Text>
            </Box>
          );
        if (item.kind === "assistant") {
          const lines = item.text.split("\n");
          const foldable = lines.length > COLLAPSE_AFTER_LINES;
          const collapsed = foldable && !expandedAll;
          if (collapsed) {
            return (
              <Box key={i} flexDirection="column" marginBottom={1}>
                <Markdown text={lines.slice(0, COLLAPSE_HEAD_LINES).join("\n")} />
                <Text dimColor>
                  … {lines.length - COLLAPSE_HEAD_LINES} more lines · Ctrl+O to expand
                </Text>
              </Box>
            );
          }
          return (
            <Box key={i} marginBottom={1}>
              <Markdown text={item.text} />
            </Box>
          );
        }
        if (item.kind === "tool") return <ToolRowView key={i} row={item.row} />;
        return (
          <Text key={i} dimColor>
            {item.text}
          </Text>
        );
      })}
    </Box>
  );
}

/** Workspace path suggestions for an active @token in the prompt. */
function MentionPicker({ mention }: { mention: { entries: MentionPath[]; sel: number } }) {
  const theme = useTheme();
  const window = visibleMentionWindow(mention.entries, mention.sel, MENTION_VISIBLE_COUNT);
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Text bold dimColor>
        File mentions ({window.selectedIndex + 1}/{mention.entries.length} · ↑/↓ select · Tab complete · Esc close)
      </Text>
      {window.entries.map((entry, i) => {
        const active = i === window.selectedIndex;
        return (
          <Text key={entry.path} color={active ? theme.accent : undefined} dimColor={!active}>
            {active ? "❯ " : "  "}
            {entry.kind === "directory" ? `${entry.path}/` : entry.path}
          </Text>
        );
      })}
    </Box>
  );
}

function HistoryPicker({ items, sel }: { items: string[]; sel: number }) {
  const theme = useTheme();
  const shown = items.slice(-8);
  const offset = items.length - shown.length;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Text bold dimColor>
        Prompt history (↑/↓ select · Enter fill · Esc close)
      </Text>
      {shown.map((t, i) => {
        const idx = offset + i;
        const active = idx === sel;
        const one = t.split("\n")[0].slice(0, 100);
        return (
          <Text key={idx} color={active ? theme.accent : undefined} dimColor={!active}>
            {active ? "❯ " : "  "}
            {one}
          </Text>
        );
      })}
    </Box>
  );
}

export function AgentApp({
  agent,
  permissions,
  sessionId,
  onCommand,
  customCommands,
  initialTheme,
}: {
  agent: Agent;
  permissions: PermissionManager;
  sessionId: string;
  onCommand: (line: string) => Promise<string | null | "quit">;
  customCommands: Map<string, SlashCommand>;
  initialTheme: Theme;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  /**
   * Ink 8 types stdout as a plain WritableStream, but inside a TTY it is a
   * WriteStream and carries `columns`. Read it through a narrow cast.
   */
  const termColumns = () => (stdout as unknown as { columns?: number }).columns ?? 80;
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [streamText, setStreamText] = useState("");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [error, setError] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageBlockParam[]>([]);
  const [planMode, setPlanMode] = useState(agent.planMode);
  const [expandedAll, setExpandedAll] = useState(false);
  const [diffPage, setDiffPage] = useState(0);
  const [diffSplit, setDiffSplit] = useState(true);
  const [termCols, setTermCols] = useState(() => termColumns());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySel, setHistorySel] = useState(0);
  const historyRef = useRef<string[]>([]); // user prompts this session, newest last
  const historyOpenRef = useRef(false);
  historyOpenRef.current = historyOpen;
  const [mention, setMention] = useState<{ entries: MentionPath[]; sel: number } | null>(null);
  const mentionOpenRef = useRef(false);
  mentionOpenRef.current = !!mention;
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  const inputRef = useRef("");
  inputRef.current = input;
  const mentionDismissedRef = useRef<{ start: number; token: string } | undefined>(undefined);

  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef("");
  const roundRef = useRef(1);
  const permissionRef = useRef<PermissionRequest | null>(null);
  permissionRef.current = permission;
  const askRef = useRef<AskState | null>(null);
  askRef.current = ask;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const imagesRef = useRef<ImageBlockParam[]>([]);
  imagesRef.current = pendingImages;
  const pastingRef = useRef(false);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const pumpRef = useRef<() => void>(() => {});
  const pumpingRef = useRef(false);

  /** Answer the current question (or skip it and every later one). */
  const finishAsk = useCallback((skipRest: boolean) => {
    const current = askRef.current;
    if (!current) return;
    askRef.current = null;
    current.resolve({
      answers: current.request.questions.map((q, i) => ({
        question: q.question,
        selected: skipRest && i >= current.index ? [] : [...current.selected[i]],
      })),
    });
  }, []);

  const advanceAsk = useCallback(() => {
    const current = askRef.current;
    if (!current) return;
    if (current.index + 1 >= current.request.questions.length) {
      finishAsk(false);
      return;
    }
    const next = { ...current, index: current.index + 1 };
    askRef.current = next;
    setAsk(next);
  }, [finishAsk]);

  const toggleAskOption = useCallback((optionIndex: number) => {
    const current = askRef.current;
    if (!current) return;
    const question = current.request.questions[current.index];
    const option = question.options[optionIndex];
    if (!option) return;
    const selected = current.selected.map((s, i) => (i === current.index ? new Set(s) : s));
    const set = selected[current.index];
    if (question.multiSelect) {
      if (set.has(option.label)) set.delete(option.label);
      else set.add(option.label);
    } else {
      set.clear();
      set.add(option.label);
    }
    const next = { ...current, selected };
    askRef.current = next;
    setAsk(next);
  }, []);

  // Let /theme (CLI side, outside React) swap the palette in place.
  useEffect(() => {
    bridge.setTheme = (next) => setTheme(next);
    bridge.getTheme = () => themeRef.current;
    return () => {
      delete bridge.setTheme;
      delete bridge.getTheme;
    };
  }, []);

  // Keep split-diff column widths in sync with terminal resizes.
  useEffect(() => {
    const onResize = () => setTermCols(termColumns());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Register the permission handler for the UI.
  useEffect(() => {
    bridge.askPermission = (
      description: string,
      risk: Risk,
      preview?: string,
      meta?: { tool: string; rule: string },
    ) =>
      new Promise<"yes" | "no" | "session" | "project" | "always" | "always_deny">((resolve) => {
        setDiffPage(0);
        setPermission({ description, risk, preview, rule: meta?.rule, resolve });
      });
    return () => {
      delete bridge.askPermission;
    };
  }, []);

  // @-mention suggestions: fetch workspace paths while the draft ends in @token.
  useEffect(() => {
    const active = resolveActiveMention(input);
    const dismissed = mentionDismissedRef.current;
    if (dismissed && (!active || dismissed.token !== active.token || dismissed.start !== active.start)) {
      mentionDismissedRef.current = undefined;
    }
    if (!active || (mentionDismissedRef.current && mentionDismissedRef.current.token === active.token)) {
      setMention(null);
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    void listWorkspacePaths(agent.cwd, { signal: controller.signal })
      .then((entries) => {
        if (cancelled) return;
        const filtered = filterMentionPaths(entries, active.token);
        setMention(filtered.length ? { entries: filtered, sel: 0 } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [input, agent.cwd]);

  // Complete the selected suggestion into the draft (reads refs, no deps).
  const applyMentionCompletionRef = useRef<() => void>(() => {});
  applyMentionCompletionRef.current = () => {
    const current = mentionRef.current;
    const text = inputRef.current;
    const active = resolveActiveMention(text);
    if (!current || !current.entries.length || !active) {
      setMention(null);
      return;
    }
    const entry = current.entries[Math.min(current.sel, current.entries.length - 1)]!;
    setInput(completeMention(text, active, entry));
    mentionDismissedRef.current = undefined;
  };

  // Keyboard: Esc interrupts / denies; permission shortcuts when a prompt is up.
  useInput(
    useCallback(
      (ch, key) => {
        const question = askRef.current;
        if (question) {
          if (key.escape) {
            finishAsk(true);
            return;
          }
          if (key.return) {
            advanceAsk();
            return;
          }
          const option = Number(ch);
          if (Number.isInteger(option) && option >= 1 && option <= 4) {
            toggleAskOption(option - 1);
          }
          return;
        }
        const perm = permissionRef.current;
        if (perm) {
          if (key.pageDown) {
            setDiffPage((p) => p + 1);
            return;
          }
          if (key.pageUp) {
            setDiffPage((p) => Math.max(0, p - 1));
            return;
          }
          const a = ch.toLowerCase();
          if (a === "t" && permissionRef.current?.preview) {
            setDiffSplit((v) => !v);
            setDiffPage(0);
            return;
          }
          if (a === "y") {
            perm.resolve("yes");
            setPermission(null);
          } else if (a === "s") {
            perm.resolve("session");
            setPermission(null);
          } else if (a === "p") {
            perm.resolve("project");
            setPermission(null);
          } else if (a === "a") {
            perm.resolve("always");
            setPermission(null);
          } else if (a === "d") {
            perm.resolve("always_deny");
            setPermission(null);
          } else if (a === "n" || key.escape) {
            perm.resolve("no");
            setPermission(null);
          }
          return;
        }
        if (key.ctrl && ch === "o") {
          setExpandedAll((v) => !v);
          return;
        }
        if (mentionOpenRef.current) {
          const current = mentionRef.current;
          if (key.upArrow || (key.ctrl && ch === "p")) {
            if (current) setMention({ ...current, sel: Math.max(0, current.sel - 1) });
            return;
          }
          if (key.downArrow || (key.ctrl && ch === "n")) {
            if (current) {
              setMention({ ...current, sel: Math.min(current.entries.length - 1, current.sel + 1) });
            }
            return;
          }
          if (key.tab) {
            applyMentionCompletionRef.current();
            return;
          }
          if (key.escape) {
            const active = resolveActiveMention(inputRef.current);
            if (active) mentionDismissedRef.current = { start: active.start, token: active.token };
            setMention(null);
            return;
          }
        }
        if (historyOpenRef.current) {
          const list = historyRef.current;
          if (key.escape) {
            setHistoryOpen(false);
            return;
          }
          if (key.upArrow || (key.ctrl && ch === "p")) {
            setHistorySel((s) => Math.max(0, s - 1));
            return;
          }
          if (key.downArrow || (key.ctrl && ch === "n")) {
            setHistorySel((s) => Math.min(list.length - 1, s + 1));
            return;
          }
          if (key.return) {
            const picked = list[historySel];
            setHistoryOpen(false);
            if (picked !== undefined) setInput(picked);
            return;
          }
          // Any other key closes the picker and falls through to the input box.
          setHistoryOpen(false);
        }
        if (key.escape && busyRef.current) {
          abortRef.current?.abort();
          return;
        }
        if (key.escape && !busyRef.current && historyRef.current.length) {
          const last = historyRef.current.length - 1;
          setHistorySel(last);
          setHistoryOpen(true);
          return;
        }
        if (key.ctrl && ch === "v" && !busyRef.current && !pastingRef.current) {
          // Paste an image from the clipboard into the pending attachments.
          pastingRef.current = true;
          captureClipboardImage()
            .then((img) => {
              if (img && !agent.supportsVision()) {
                setItems((prev) => [...prev, { kind: "system", text: "(current model does not support vision — image not attached; switch with /model)" }]);
              } else if (img) {
                setPendingImages((prev) => [...prev, img]);
              } else {
                setItems((prev) => [...prev, { kind: "system", text: "(clipboard has no image)" }]);
              }
            })
            .finally(() => {
              pastingRef.current = false;
            });
          return;
        }
        if (key.ctrl && ch === "c") {
          if (busyRef.current) abortRef.current?.abort();
          else exit();
        }
      },
      [historySel, exit, finishAsk, advanceAsk, toggleAskOption],
    ),
  );

  // Poll the shared todo store after each turn.
  const refreshTodos = useCallback(() => setTodos([...agent.currentTodos()]), [agent]);

  // Clear the screen on mount for a clean start.
  useEffect(() => {
    stdout.write("\x1b[2J\x1b[H");
  }, [stdout]);

  const runTurn = useCallback(
    async (
      text: string,
      display: string,
      images: ImageBlockParam[],
      opts: { goalContinuation?: boolean } = {},
    ) => {
      setError("");
      setBusy(true);
      setStreamText("");
      streamRef.current = "";
      roundRef.current = 1;
      setPendingImages([]);
      setDiffPage(0);
      // Remember plain user prompts (not slash commands) for the Esc history picker.
      if (!opts.goalContinuation && !display.startsWith("/") && display.trim()) {
        const h = historyRef.current;
        if (h[h.length - 1] !== display) h.push(display);
      }
      setItems((prev) => [...prev, { kind: "user", text: display + (images.length ? ` [+${images.length} image${images.length > 1 ? "s" : ""}]` : "") }]);
      const controller = new AbortController();
      abortRef.current = controller;

      // Accumulate the current turn's tool rows so we can group them.
      const events: AgentEvents = {
        onTextDelta: (d) => {
          streamRef.current += d;
          setStreamText(streamRef.current);
        },
        onRoundStart: (round) => {
          roundRef.current = round;
        },
        onToolStart: (id, name, preview) => {
          // Freeze any narration text before the tool call into the transcript.
          if (streamRef.current) {
            const narration = streamRef.current;
            streamRef.current = "";
            setStreamText("");
            setItems((prev) => [...prev, { kind: "assistant", text: narration, round: roundRef.current }]);
          }
          setItems((prev) => [
            ...prev,
            { kind: "tool", row: { id, name, preview, status: "running", round: roundRef.current } },
          ]);
        },
        onToolEnd: (id, _name, ok, result) => {
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "tool" && it.row.id === id
                ? { kind: "tool", row: { ...it.row, status: ok ? "ok" : "error", result } }
                : it,
            ),
          );
        },
        onCostWarning: (message) => setItems((prev) => [...prev, { kind: "system", text: `[cost] ${message}` }]),
        onCompacting: () => setItems((prev) => [...prev, { kind: "system", text: "… compacting context …" }]),
        onCompacted: (before, after) =>
          setItems((prev) => [
            ...prev,
            { kind: "system", text: `context compacted: ${before.toLocaleString()} → ${after.toLocaleString()} tokens` },
          ]),
        onRetry: (info) => {
          const why = info.reason === "server" ? `HTTP ${info.status}` : info.reason;
          const secs = Math.round(info.delayMs / 100) / 10;
          setItems((prev) => [
            ...prev,
            { kind: "system", text: `retrying in ${secs}s (${info.attempt}/${info.maxAttempts}, ${why})` },
          ]);
        },
        onStreamRecovery: (info) => {
          const secs = Math.round(info.delayMs / 100) / 10;
          const what =
            info.mode === "restart" ? "discarding partial output and restarting" : "resuming from the cut-off point";
          if (info.mode === "restart") {
            const round = roundRef.current;
            streamRef.current = "";
            setStreamText("");
            // Narration and early tool rows belong to the abandoned response.
            setItems((prev) => [
              ...prev.filter(
                (it) =>
                  !(it.kind === "tool" && it.row.round === round) &&
                  !(it.kind === "assistant" && it.round === round),
              ),
              { kind: "system", text: `stream interrupted — ${what} (${info.attempt}/${info.maxAttempts}, ${secs}s)` },
            ]);
          } else {
            setItems((prev) => [
              ...prev,
              { kind: "system", text: `stream interrupted — ${what} (${info.attempt}/${info.maxAttempts}, ${secs}s)` },
            ]);
          }
        },
        onHook: (event, message) => setItems((prev) => [...prev, { kind: "system", text: `[hook ${event}] ${message}` }]),
        onGoalChanged: (goal, note) =>
          setItems((prev) => [
            ...prev,
            { kind: "system", text: `[goal] ${note ?? "updated"}${goal ? ` · ${goalSummaryLine(goal)}` : ""}` },
          ]),
        onGoalChecking: () =>
          setItems((prev) => [...prev, { kind: "system", text: "[goal] verifying whether the objective is complete…" }]),
        onPlanApproved: () => {
          setItems((prev) => [...prev, { kind: "system", text: "plan approved — switching to execution mode" }]);
          setPlanMode(false);
        },
        onUserQuestion: (request, signal) =>
          new Promise<UserQuestionOutcome>((resolve) => {
            let settled = false;
            let onAbort = () => {};
            const finish = (outcome: UserQuestionOutcome) => {
              if (settled) return;
              settled = true;
              signal.removeEventListener("abort", onAbort);
              askRef.current = null;
              setAsk(null);
              resolve(outcome);
            };
            onAbort = () => finish({ answers: [], timedOut: true });
            if (signal.aborted) {
              resolve({ answers: [], aborted: true });
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            const next: AskState = {
              request,
              index: 0,
              selected: request.questions.map(() => new Set<string>()),
              resolve: finish,
            };
            askRef.current = next;
            setAsk(next);
          }),
      };

      try {
        const finalText = await agent.chat(
          text,
          controller.signal,
          events,
          images,
          opts.goalContinuation ? { goalContinuation: true } : undefined,
        );
        streamRef.current = "";
        setItems((prev) => (finalText ? [...prev, { kind: "assistant", text: finalText }] : prev));
        setStreamText("");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "aborted") {
          setItems((prev) => [...prev, { kind: "system", text: "(interrupted)" }]);
        } else {
          setError(sanitizeErrorMessage(msg) ?? msg);
        }
        setStreamText("");
      } finally {
        abortRef.current = null;
        setBusy(false);
        // Mirror the state update synchronously so the pump can claim the next
        // queued turn before React re-renders.
        busyRef.current = false;
        refreshTodos();
        pumpRef.current();
      }
    },
    [agent, refreshTodos],
  );

  /**
   * Drain queued send_prompt commands (goal continuations) as follow-up turns.
   * Re-entrant calls collapse into the outer loop; a real user turn set busy
   * first wins because the pump only starts when the UI is idle.
   */
  const pumpQueue = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        if (busyRef.current) return;
        const cmd = agent.runtimeQueue.take("send_prompt");
        if (!cmd) return;
        const goalTurn = cmd.source === "goal";
        const goal = goalTurn ? agent.currentGoal() : null;
        const label = goalTurn ? `↻ ${goal ? goalSummaryLine(goal) : "goal continuation"}` : cmd.prompt;
        try {
          await runTurn(cmd.prompt, label, (cmd.images ?? []) as ImageBlockParam[], { goalContinuation: goalTurn });
          agent.runtimeQueue.complete(cmd.id);
        } catch (err) {
          agent.runtimeQueue.complete(cmd.id, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [agent, runTurn]);
  pumpRef.current = () => {
    void pumpQueue();
  };

  const onSubmit = useCallback(
    async (value: string) => {
      const text = value.trim();
      if (mentionOpenRef.current) {
        // Enter with the mention panel open completes the path instead of sending.
        applyMentionCompletionRef.current();
        return;
      }
      setInput("");
      const images = imagesRef.current;
      if (!text && !images.length) return;
      if (busyRef.current) {
        // Mid-turn input steers the running turn instead of being dropped.
        const prepared = await prepareImagesForModel(images, imagePrepareLimits());
        if (!agent.steer(text, prepared.images)) return; // turn just ended; next submit runs normally
        setItems((prev) => [...prev, { kind: "user", text }]);
        setItems((prev) => [...prev, { kind: "system", text: "(queued — applied at the next step)" }]);
        return;
      }
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.slice(1).split(/\s+/);
        const custom = customCommands.get(cmd);
        if (custom) {
          const rendered = renderCommand(custom.template, rest);
          const expanded = await expandFileReferences(rendered, agent.cwd);
          await runTurn(expanded.text, `${text}  (/${cmd})`, images);
          return;
        }
        const result = await onCommand(text);
        if (result === "quit") {
          exit();
          return;
        }
        setPlanMode(agent.planMode);
        if (result) setItems((prev) => [...prev, { kind: "system", text: result }]);
        refreshTodos();
        // /goal start|resume leaves a continuation queued; run it right away.
        pumpRef.current();
        return;
      }
      const expanded = await expandFileReferences(text, agent.cwd);
      if (expanded.files.length)
        setItems((prev) => [...prev, { kind: "system", text: `@ referenced: ${expanded.files.join(", ")}` }]);
      await runTurn(expanded.text, text, images);
    },
    [onCommand, runTurn, exit, refreshTodos, customCommands, agent.cwd],
  );

  // Keep only the tail of the transcript in view; older tool rows collapse.
  const visibleItems = useMemo(() => {
    const out: TranscriptItem[] = [];
    let toolRun: ToolRow[] = [];
    const flush = () => {
      if (!toolRun.length) return;
      if (toolRun.length > MAX_VISIBLE_TOOLS) {
        const hidden = toolRun.slice(0, toolRun.length - MAX_VISIBLE_TOOLS);
        out.push({ kind: "system", text: `… ${hidden.length} earlier tool calls` });
        toolRun = toolRun.slice(-MAX_VISIBLE_TOOLS);
      }
      for (const row of toolRun) out.push({ kind: "tool", row });
      toolRun = [];
    };
    for (const it of items) {
      if (it.kind === "tool") toolRun.push(it.row);
      else {
        flush();
        out.push(it);
      }
    }
    flush();
    return out;
  }, [items]);

  return (
    <ThemeContext.Provider value={theme}>
      <Box flexDirection="column">
        <TranscriptView items={visibleItems} expandedAll={expandedAll} />

        {busy && streamText && (
          <Box marginBottom={1}>
            <Markdown text={streamText} />
          </Box>
        )}

        {busy && !streamText && (
          <Text dimColor>
            ⏺ thinking… <Text color={theme.border}>(Esc to interrupt)</Text>
          </Text>
        )}

        {permission && <PermissionPrompt request={permission} diffPage={diffPage} diffSplit={diffSplit} termCols={termCols} />}

        {ask && <QuestionPrompt ask={ask} />}

        {error && <Text color={theme.error}>Error: {error}</Text>}

        <TodoPanel todos={todos} />

        {historyOpen && <HistoryPicker items={historyRef.current} sel={historySel} />}

        {mention && <MentionPicker mention={mention} />}

        <Box>
          <Text color={theme.user} bold>
            {"❯ "}
          </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={onSubmit}
            focus={!permission && !historyOpen && !ask}
            placeholder={busy ? "steer the running turn — input is queued" : "ask the agent… (/help · Esc history · Ctrl+O expand)"}
          />
        </Box>

        <StatusBar agent={agent} planMode={planMode} expandedAll={expandedAll} permissions={permissions} sessionId={sessionId} />
      </Box>
    </ThemeContext.Provider>
  );
}

/** Bottom status line: model, session, live context usage, spend, bg tasks. */
function StatusBar({
  agent,
  planMode,
  expandedAll,
  permissions,
  sessionId,
}: {
  agent: Agent;
  planMode: boolean;
  expandedAll: boolean;
  permissions: PermissionManager;
  sessionId: string;
}) {
  const est = agent.tokenEstimate();
  const win = agent.contextWindow;
  const pct = win > 0 ? Math.round((est / win) * 100) : 0;
  const bgRunning = backgroundManager.list().filter((t) => !t.done).length;
  const theme = useTheme();
  const tight = pct >= Math.round(COMPACT_RATIO * 100);
  return (
    <Text dimColor>
      {planMode && <Text color={theme.plan} bold>{"PLAN "}</Text>}
      {agent.provider}:{agent.model} · session {agent.sessionId} · ctx {est.toLocaleString()}/{win.toLocaleString()} ({pct}%)
      {tight ? <Text color={theme.warn}>{" ⚠"}</Text> : ""} · ${agent.costs.totalUsd().toFixed(2)}
      {bgRunning ? ` · bg ${bgRunning}` : ""} · mode {permissions.mode}
      {expandedAll ? " · all expanded (Ctrl+O)" : ""}
      <Text color={theme.border}>{` · ${theme.id}`}</Text>
    </Text>
  );
}
