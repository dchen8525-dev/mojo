import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Agent } from "./agent.js";
import { PermissionManager } from "./permissions.js";
import { createSession } from "./session.js";
import { tools } from "./tools/index.js";
import type { Tool } from "./types.js";

/**
 * MCP server mode (`agent --mcp-server`): expose mojo itself as a Model
 * Context Protocol server over stdio so other agents/clients (Claude Code,
 * Cursor, ...) can orchestrate it.
 *
 * Surface:
 * - tools: every read-only local tool (read_file, grep, glob, web_search, ...)
 *   plus `agent_chat`, which runs a full mojo turn. `agent_chat` is safe by
 *   default - write/shell operations auto-deny headlessly - unless the caller
 *   explicitly passes `yolo: true`.
 * - resources: the project's instruction/memory files, so an orchestrator can
 *   read what the agent knows without a chat round-trip.
 */

const AGENT_CHAT: Tool = {
  name: "agent_chat",
  description:
    "Run one full mojo agent turn (tool loop included) against the project. Returns the agent's final text. " +
    "By default write/shell tools auto-deny (headless, nobody to approve), so it behaves like a capable " +
    "read-and-analyze agent. Pass yolo:true to let it actually modify files - only do that when the user " +
    "has asked for it.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The task for the agent." },
      session_id: {
        type: "string",
        description: "Optional id to continue a previous agent_chat conversation; omit for a fresh session.",
      },
      yolo: { type: "boolean", description: "Auto-approve write/shell tools for this turn (default false)." },
    },
    required: ["prompt"],
  },
  execute: async () => ({ content: "handled by the MCP server", isError: true }),
};

export function exposedTools(): Tool[] {
  return [...tools.filter((t) => t.isReadOnly), AGENT_CHAT];
}

interface ChatSession {
  agent: Agent;
  history: number;
}

/** Build the MCP Server (without connecting it - `serveMcp` wires stdio). */
export function buildMcpServer(cwd: string): Server {
  const server = new Server({ name: "mojo", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
  const chats = new Map<string, ChatSession>();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const input = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (name === AGENT_CHAT.name) {
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      if (!prompt.trim()) return { content: [{ type: "text" as const, text: "prompt must not be empty" }], isError: true };
      const yolo = input.yolo === true;
      let id = typeof input.session_id === "string" && input.session_id ? input.session_id : "";
      let entry = id ? chats.get(id) : undefined;
      if (!entry) {
        const s = await createSession(cwd);
        id = s.id;
        const permissions = new PermissionManager(async () => "no" as const);
        if (yolo) permissions.mode = "yolo";
        entry = { agent: new Agent(cwd, s.id, permissions), history: 0 };
        chats.set(id, entry);
      }
      try {
        const text = await entry.agent.chat(prompt);
        entry.history++;
        return {
          content: [{ type: "text" as const, text: `[mojo session ${id}]\n${text || "(no text response)"}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `agent_chat failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }

    const tool = exposedTools().find((t) => t.name === name);
    if (!tool) return { content: [{ type: "text" as const, text: `Unknown tool "${name}".` }], isError: true };
    // Headless context: read-only tools never prompt; anything else is refused.
    const ctx = {
      cwd,
      askPermission: async () => false,
    };
    try {
      const result = await tool.execute(input, ctx);
      return { content: [{ type: "text" as const, text: result.content }], isError: !!result.isError };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Tool crashed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  const resourceFiles = () => [
    { uri: "file:///AGENTS.md", abs: path.join(cwd, "AGENTS.md"), name: "AGENTS.md" },
    { uri: "file:///CLAUDE.md", abs: path.join(cwd, "CLAUDE.md"), name: "CLAUDE.md" },
    { uri: "file:///.node-agent/memory.md", abs: path.join(cwd, ".node-agent", "memory.md"), name: "memory.md" },
  ];

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const out: Array<{ uri: string; name: string; mimeType: string }> = [];
    for (const r of resourceFiles()) {
      try {
        await fs.access(r.abs);
        out.push({ uri: r.uri, name: r.name, mimeType: "text/markdown" });
      } catch {
        /* optional */
      }
    }
    return { resources: out };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const r = resourceFiles().find((x) => x.uri === req.params.uri);
    if (!r) throw new Error(`unknown resource ${req.params.uri}`);
    const text = await fs.readFile(r.abs, "utf8");
    return { contents: [{ uri: r.uri, mimeType: "text/markdown", text }] };
  });

  return server;
}

/** Serve over stdio until the client disconnects. */
export async function serveMcp(cwd: string): Promise<void> {
  const server = buildMcpServer(cwd);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`mojo MCP server ready on stdio (cwd: ${cwd})\n`);
}
