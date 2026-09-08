# mojo

A Claude Code-like AI coding agent built with Node.js + TypeScript, running in your terminal.

It drives an agent loop (context assembly → LLM call → tool execution → result backfill) with file
tools, shell access, permission controls, session persistence, multi-model support, subagents, MCP,
hooks, and an Ink-based interactive UI.

## Features

- **Agent loop** with up to 40 tool iterations per turn, auto-resume on truncated output, and
  context compaction when the window fills up
- **Built-in tools**: `read_file`, `write_file`, `edit_file`, `bash`, `glob_files`, `grep`,
  `todo_write`, `task` (research subagent)
- **Parallel tool execution**: read-only / subagent tools run concurrently; mutating tools stay
  sequential
- **Permission system**: read ops auto-approved, writes and risky commands prompt; `y` / `a`
  (always allow) / `d` (always deny) / `n`, persisted rules, `--auto` and `--yolo` modes
- **Multi-model**: Anthropic and OpenAI (Chat Completions) backends, hot-swap via `/model`,
  aliases (`sonnet` / `opus` / `haiku` / `gpt`), per-model context windows
- **Streaming with breakpoint recovery**: interrupted streams resume from the partial output
  instead of re-running the request; transient API failures retry with backoff
- **Accurate token accounting**: exact API usage as an anchor plus a CJK-aware delta estimate —
  compaction triggers on real numbers, not chars/3.5
- **Session persistence**: JSONL under `~/.node-agent/sessions/`, `/sessions` + `--resume`
- **Image input**: paste a clipboard screenshot with `Ctrl+V` (Windows / macOS / Linux)
- **`@file` references**: inline file contents into your prompt (`@src/foo.ts`, `@"my file.txt"`)
- **Custom slash commands**: markdown prompt templates in `.node-agent/commands/*.md`
- **Hooks**: shell commands at `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop`
- **MCP client**: connect stdio servers from `~/.node-agent/mcp.json` or `.mcp.json`
- **Project instructions**: `AGENTS.md` / `CLAUDE.md` injected into the system prompt

## Install

```bash
npm install
npm run build
npm link        # exposes the `agent` binary, or use: node dist/cli.js
```

Requires Node.js >= 20.

## Configure

Credentials resolve from environment first, then `~/.node-agent/config.json`:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "baseURL": "https://api.anthropic.com",
  "apiKey": "sk-..."
}
```

Environment variables: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `AGENT_MODEL`, `AGENT_PROVIDER`,
`AGENT_BASE_URL`. Any OpenAI-compatible gateway works via `--provider openai --base-url …`.

## Usage

```bash
agent                         # interactive UI
agent -p "explain this repo"  # one-shot print mode
agent --resume <id>           # continue a saved session
agent --model openai:gpt-4o   # pin a model at startup
agent --auto                  # auto-approve non-high-risk writes
agent --yolo                  # approve everything (careful)
agent --no-mcp                # skip MCP servers
```

### Interactive shortcuts

| Key | Action |
| --- | --- |
| `Enter` | submit prompt |
| `Esc` | interrupt the running turn / deny a prompt |
| `Ctrl+C` | interrupt, or quit when idle |
| `Ctrl+V` | attach an image from the clipboard |
| `y` / `a` / `d` / `n` | allow once / always allow / always deny / deny once (permission prompt) |

### Slash commands

`/help` · `/model [spec|list]` · `/auto [on|off]` · `/yolo` · `/mcp` · `/permissions [clear]` ·
`/hooks` · `/sessions` · `/resume <id>` · `/todos` · `/clear` · `/quit`

### `@file` references

Type `@path/to/file` anywhere in a prompt and its contents are inlined as
`<file path="…">…</file>` blocks (workspace paths only, ~200 KB total budget).

### Custom slash commands

Drop markdown files in `~/.node-agent/commands/` (global) or `.node-agent/commands/` (project);
the file name becomes the command. The body is a prompt template with `$ARGUMENTS` or `$1`…`$9`
placeholders, and an optional `description:` front-matter line:

```markdown
---
description: review a file for bugs
---
Review @$1 for correctness issues. Focus on edge cases.
```

Invoke with `/review src/foo.ts`.

### Hooks

`~/.node-agent/hooks.json` (global) and `.node-agent/hooks.json` (project):

```json
{
  "PreToolUse": [
    { "matcher": "bash", "command": "node scripts/guard.js", "timeout": 5000 }
  ],
  "PostToolUse": [
    { "matcher": "edit_file,write_file", "command": "npx prettier --write ..." }
  ]
}
```

Each hook receives a JSON payload on stdin. Exit `2` blocks the action (stderr becomes the
reason), other non-zero exits surface as warnings, and exit `0` stdout is injected as extra
context. `matcher` is a comma-separated tool list or a regex; omit it for all tools.

### MCP servers

`~/.node-agent/mcp.json` or `<cwd>/.mcp.json`:

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

Remote tools are namespaced `mcp__<server>__<tool>`; check status with `/mcp`.

### Subagents

The `task` tool spawns read-only research subagents with fresh context; the model can launch
several in parallel for independent investigations.

## Development

```bash
npm run dev      # run from source with tsx
npm run build    # tsc -> dist/
npm test         # vitest run
npm run test:watch
```

Tests cover token accounting, agent scheduling/hooks integration, the hook runner, slash-command
rendering, `@file` expansion, and session persistence.
