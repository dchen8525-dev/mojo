import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { Agent, COMPACT_RATIO, type AgentEvents } from "../agent.js";
import type { PermissionManager } from "../permissions.js";
import type { ImageBlockParam, Risk } from "../types.js";
import type { TodoItem } from "../tools/todo.js";
import { bridge } from "./bridge.js";
import { Markdown } from "./markdown.js";
import { ThemeContext, useTheme, type Theme } from "./theme.js";
import { clipCell, GUTTER, looksLikeDiff, splitColumnWidth, splitDiffRows } from "./splitDiff.js";
import { captureClipboardImage } from "../clipboard.js";
import { backgroundManager } from "../tools/background.js";
import { expandFileReferences, renderCommand, type SlashCommand } from "../commands.js";

interface ToolRow {
  id: string;
  name: string;
  preview: string;
  status: "running" | "ok" | "error";
  result?: string;
}

type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; row: ToolRow }
  | { kind: "system"; text: string };

interface PermissionRequest {
  description: string;
  risk: Risk;
  preview?: string;
  resolve: (answer: "yes" | "no" | "always" | "always_deny") => void;
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
      <Text dimColor>y = allow once · a = always allow · d = always deny · n / Esc = deny once · t = toggle split diff</Text>
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
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [streamText, setStreamText] = useState("");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [error, setError] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageBlockParam[]>([]);
  const [planMode, setPlanMode] = useState(agent.planMode);
  const [expandedAll, setExpandedAll] = useState(false);
  const [diffPage, setDiffPage] = useState(0);
  const [diffSplit, setDiffSplit] = useState(true);
  const [termCols, setTermCols] = useState(() => stdout.columns ?? 80);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySel, setHistorySel] = useState(0);
  const historyRef = useRef<string[]>([]); // user prompts this session, newest last
  const historyOpenRef = useRef(false);
  historyOpenRef.current = historyOpen;

  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef("");
  const permissionRef = useRef<PermissionRequest | null>(null);
  permissionRef.current = permission;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const imagesRef = useRef<ImageBlockParam[]>([]);
  imagesRef.current = pendingImages;
  const pastingRef = useRef(false);
  const themeRef = useRef(theme);
  themeRef.current = theme;

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
    const onResize = () => setTermCols(stdout.columns ?? 80);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Register the permission handler for the UI.
  useEffect(() => {
    bridge.askPermission = (description: string, risk: Risk, preview?: string) =>
      new Promise<"yes" | "no" | "always" | "always_deny">((resolve) => {
        setDiffPage(0);
        setPermission({ description, risk, preview, resolve });
      });
    return () => {
      delete bridge.askPermission;
    };
  }, []);

  // Keyboard: Esc interrupts / denies; permission shortcuts when a prompt is up.
  useInput(
    useCallback(
      (ch, key) => {
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
      [historySel, exit],
    ),
  );

  // Poll the shared todo store after each turn.
  const refreshTodos = useCallback(() => setTodos([...agent.currentTodos()]), [agent]);

  // Clear the screen on mount for a clean start.
  useEffect(() => {
    stdout.write("\x1b[2J\x1b[H");
  }, [stdout]);

  const runTurn = useCallback(
    async (text: string, display: string, images: ImageBlockParam[]) => {
      setError("");
      setBusy(true);
      setStreamText("");
      setPendingImages([]);
      setDiffPage(0);
      // Remember plain user prompts (not slash commands) for the Esc history picker.
      if (!display.startsWith("/") && display.trim()) {
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
        onToolStart: (id, name, preview) => {
          // Freeze any narration text before the tool call into the transcript.
          if (streamRef.current) {
            const narration = streamRef.current;
            streamRef.current = "";
            setStreamText("");
            setItems((prev) => [...prev, { kind: "assistant", text: narration }]);
          }
          setItems((prev) => [...prev, { kind: "tool", row: { id, name, preview, status: "running" } }]);
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
        onHook: (event, message) => setItems((prev) => [...prev, { kind: "system", text: `[hook ${event}] ${message}` }]),
        onPlanApproved: () => {
          setItems((prev) => [...prev, { kind: "system", text: "plan approved — switching to execution mode" }]);
          setPlanMode(false);
        },
      };

      try {
        const finalText = await agent.chat(text, controller.signal, events, images);
        streamRef.current = "";
        setItems((prev) => (finalText ? [...prev, { kind: "assistant", text: finalText }] : prev));
        setStreamText("");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "aborted") {
          setItems((prev) => [...prev, { kind: "system", text: "(interrupted)" }]);
        } else {
          setError(msg);
        }
        setStreamText("");
      } finally {
        abortRef.current = null;
        setBusy(false);
        refreshTodos();
      }
    },
    [agent, refreshTodos],
  );

  const onSubmit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      const images = imagesRef.current;
      if (!text && !images.length) return;
      if (busyRef.current) return; // ignore submissions while a turn is running
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

        {error && <Text color={theme.error}>Error: {error}</Text>}

        <TodoPanel todos={todos} />

        {historyOpen && <HistoryPicker items={historyRef.current} sel={historySel} />}

        <Box>
          <Text color={theme.user} bold>
            {"❯ "}
          </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={onSubmit}
            focus={!permission && !historyOpen}
            placeholder={busy ? "waiting for agent…" : "ask the agent… (/help · Esc history · Ctrl+O expand)"}
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
