import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock, MessageParam, ToolUseBlock } from "../src/types.js";

// Scripted fake LLM so agent_chat works without network or API keys.
const h = vi.hoisted(() => ({
  turns: [] as Array<{ content: ContentBlock[]; inputTokens: number; outputTokens: number }>,
  calls: 0,
}));

vi.mock("../src/llm.js", () => ({
  LLM: class FakeLLM {
    provider = "anthropic";
    model = "fake";
    contextWindow = 100_000;
    async send(_messages: MessageParam[]) {
      const t = h.turns[h.calls++];
      if (!t) throw new Error("fake LLM ran out of scripted turns");
      const toolUses = t.content.filter((b): b is ToolUseBlock => (b as { type?: string }).type === "tool_use");
      const text = t.content.filter((b) => (b as { type?: string }).type === "text").map((b) => (b as { text: string }).text).join("");
      return {
        text,
        toolUses,
        content: t.content,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        stopReason: toolUses.length ? "tool_use" : "end_turn",
      };
    }
    switchModel() {
      return { provider: "anthropic" as const, model: "fake" };
    }
    listModels() {
      return Promise.resolve<string[]>([]);
    }
  },
}));

// Keep tests from writing real session files into ~/.node-agent/sessions.
vi.mock("../src/session.js", () => {
  let n = 0;
  return {
    createSession: async (cwd: string) => {
      n++;
      return { id: `mcp-test-${n}`, meta: { id: `mcp-test-${n}`, cwd, startedAt: "", updatedAt: "" } };
    },
    appendMessages: async () => {},
    appendModel: async () => {},
    rewriteMessages: async () => {},
  };
});

vi.mock("../src/memory.js", () => ({
  renderMemory: async () => "",
  appendMemoryNote: async () => null,
}));

const { buildMcpServer, exposedTools } = await import("../src/mcpServer.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let cwd: string;

async function connect() {
  const server = buildMcpServer(cwd);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

function textTurn(text: string) {
  return { content: [{ type: "text", text } as ContentBlock], inputTokens: 10, outputTokens: 5 };
}

beforeAll(async () => {
  cwd = await import("node:fs").then((fs) => fs.promises.mkdtemp(path.join(os.tmpdir(), "mcpserver-")));
  const { promises: fs } = await import("node:fs");
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "# project rules\nbe nice\n", "utf8");
  await fs.mkdir(path.join(cwd, ".node-agent"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".node-agent", "memory.md"), "remembered fact\n", "utf8");
});

beforeEach(() => {
  h.turns = [];
  h.calls = 0;
});

describe("exposedTools", () => {
  it("includes read-only tools plus agent_chat, never write tools", () => {
    const names = exposedTools().map((t) => t.name);
    expect(names).toContain("agent_chat");
    expect(names).toContain("read_file");
    expect(names).toContain("web_search");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
  });
});

describe("mojo MCP server", () => {
  it("lists tools including agent_chat", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("agent_chat");
    await client.close();
  });

  it("runs a read-only tool through tools/call", async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: "glob_files",
      arguments: { pattern: "AGENTS.md", path: cwd },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("AGENTS.md");
    await client.close();
  });

  it("refuses a write tool that is not exposed", async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: "edit_file",
      arguments: { file: "x", edits: [] },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown tool");
    await client.close();
  });

  it("agent_chat returns the scripted final text and a session id", async () => {
    h.turns = [textTurn("hello from mojo")];
    const client = await connect();
    const res = (await client.callTool({
      name: "agent_chat",
      arguments: { prompt: "say hi" },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("hello from mojo");
    expect(res.content[0].text).toContain("mojo session");
    await client.close();
  });

  it("agent_chat continues the same session when session_id is reused", async () => {
    h.turns = [textTurn("first"), textTurn("second")];
    const client = await connect();
    const r1 = (await client.callTool({ name: "agent_chat", arguments: { prompt: "one" } })) as {
      content: Array<{ text: string }>;
    };
    const id = /mojo session ([^\]]+)\]/.exec(r1.content[0].text)?.[1];
    expect(id).toBeTruthy();
    const r2 = (await client.callTool({ name: "agent_chat", arguments: { prompt: "two", session_id: id } })) as {
      content: Array<{ text: string }>;
    };
    expect(r2.content[0].text).toContain("second");
    expect(r2.content[0].text).toContain(id!);
    // The second turn's history contains the first exchange.
    expect(h.calls).toBe(2);
    await client.close();
  });

  it("agent_chat with an unknown session_id starts fresh instead of failing", async () => {
    h.turns = [textTurn("fresh")];
    const client = await connect();
    const res = (await client.callTool({
      name: "agent_chat",
      arguments: { prompt: "hi", session_id: "does-not-exist" },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("fresh");
    await client.close();
  });

  it("lists and reads project resources", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("file:///AGENTS.md");
    expect(uris).toContain("file:///.node-agent/memory.md");
    const res = await client.readResource({ uri: "file:///AGENTS.md" });
    expect(res.contents[0].text).toContain("be nice");
    await client.close();
  });
});
