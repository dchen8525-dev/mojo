import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { Agent, AgentEvents } from "../agent.js";
import type { PermissionManager } from "../permissions.js";
import type { ImageBlockParam, Risk } from "../types.js";
import type { TodoItem } from "../tools/todo.js";
import { bridge } from "./bridge.js";
import { Markdown } from "./markdown.js";
import { captureClipboardImage } from "../clipboard.js";
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
  resolve: (answer: "yes" | "no" | "always" | "always_deny") => void;
}

const MAX_VISIBLE_TOOLS = 6;

function ToolRowView({ row }: { row: ToolRow }) {
  const icon = row.status === "running" ? "⚡" : row.status === "ok" ? "✓" : "✗";
  const color = row.status === "running" ? "cyan" : row.status === "ok" ? "green" : "red";
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
  if (!todos.length) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold dimColor>
        Tasks
      </Text>
      {todos.map((t) => (
        <Text key={t.id} color={t.status === "completed" ? "green" : t.status === "in_progress" ? "yellow" : "gray"}>
          {t.status === "completed" ? "[x] " : t.status === "in_progress" ? "[>] " : "[ ] "}
          {t.content}
        </Text>
      ))}
    </Box>
  );
}

function PermissionPrompt({ request }: { request: PermissionRequest }) {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={request.risk === "high" ? "red" : "yellow"} paddingX={1}>
      <Text bold color={request.risk === "high" ? "red" : "yellow"}>
        Permission required {request.risk === "high" ? "(high risk)" : "(write)"}
      </Text>
      <Text>{request.description}</Text>
      <Text dimColor>y = allow once · a = always allow · d = always deny · n / Esc = deny once</Text>
    </Box>
  );
}

function TranscriptView({ items }: { items: TranscriptItem[] }) {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        if (item.kind === "user")
          return (
            <Box key={i} marginBottom={1}>
              <Text color="green" bold>
                {"❯ "}
              </Text>
              <Text>{item.text}</Text>
            </Box>
          );
        if (item.kind === "assistant")
          return (
            <Box key={i} marginBottom={1}>
              <Markdown text={item.text} />
            </Box>
          );
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

export function AgentApp({
  agent,
  permissions,
  sessionId,
  onCommand,
  customCommands,
}: {
  agent: Agent;
  permissions: PermissionManager;
  sessionId: string;
  onCommand: (line: string) => Promise<string | null | "quit">;
  customCommands: Map<string, SlashCommand>;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [streamText, setStreamText] = useState("");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [usage, setUsage] = useState({ input: 0, output: 0 });
  const [error, setError] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageBlockParam[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef("");
  const permissionRef = useRef<PermissionRequest | null>(null);
  permissionRef.current = permission;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const imagesRef = useRef<ImageBlockParam[]>([]);
  imagesRef.current = pendingImages;
  const pastingRef = useRef(false);

  // Register the permission handler for the UI.
  useEffect(() => {
    bridge.askPermission = (description: string, risk: Risk) =>
      new Promise<"yes" | "no" | "always" | "always_deny">((resolve) => setPermission({ description, risk, resolve }));
    return () => {
      delete bridge.askPermission;
    };
  }, []);

  // Keyboard: Esc interrupts / denies; permission shortcuts when a prompt is up.
  useInput(
    useCallback((ch, key) => {
      const perm = permissionRef.current;
      if (perm) {
        const a = ch.toLowerCase();
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
      if (key.escape && busyRef.current) {
        abortRef.current?.abort();
      }
      if (key.ctrl && ch === "v" && !busyRef.current && !pastingRef.current) {
        // Paste an image from the clipboard into the pending attachments.
        pastingRef.current = true;
        captureClipboardImage()
          .then((img) => {
            if (img) setPendingImages((prev) => [...prev, img]);
            else setItems((prev) => [...prev, { kind: "system", text: "(clipboard has no image)" }]);
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
    }, []),
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
        onUsage: (inp, out) => setUsage({ input: inp, output: out }),
        onCompacting: () => setItems((prev) => [...prev, { kind: "system", text: "… compacting context …" }]),
        onHook: (event, message) => setItems((prev) => [...prev, { kind: "system", text: `[hook ${event}] ${message}` }]),
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
    <Box flexDirection="column">
      <TranscriptView items={visibleItems} />

      {busy && streamText && (
        <Box marginBottom={1}>
          <Markdown text={streamText} />
        </Box>
      )}

      {busy && !streamText && (
        <Text dimColor>
          ⏺ thinking… <Text color="gray">(Esc to interrupt)</Text>
        </Text>
      )}

      {permission && <PermissionPrompt request={permission} />}

      {error && <Text color="red">Error: {error}</Text>}

      <TodoPanel todos={todos} />

      <Box>
        <Text color="green" bold>
          {"❯ "}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          focus={!permission}
          placeholder={busy ? "waiting for agent…" : "ask the agent… (/help)"}
        />
      </Box>

      <Text dimColor>
        {agent.provider}:{agent.model} · session {sessionId} · ctx in {usage.input} / out {usage.output} · mode{" "}
        {permissions.mode}
      </Text>
    </Box>
  );
}
