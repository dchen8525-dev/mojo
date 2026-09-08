import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Redirect the session store into a temp "home" so tests never touch the
// real ~/.node-agent directory. The mock must be installed before session.js
// computes SESSION_DIR at import time, hence the dynamic import below.
const fakeHome = path.join(os.tmpdir(), "node-agent-test-home");

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const patched = { ...actual, homedir: () => fakeHome };
  return { ...patched, default: patched };
});

const session = await import("../src/session.js");

beforeAll(async () => {
  await fs.rm(fakeHome, { recursive: true, force: true });
  await fs.mkdir(path.join(fakeHome, ".node-agent", "sessions"), { recursive: true });
});

describe("createSession / loadSession", () => {
  it("round-trips meta and messages", async () => {
    const { id, meta } = await session.createSession("D:\\proj");
    expect(meta.id).toBe(id);
    expect(meta.model).toBeUndefined();

    await session.appendMessages(id, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const loaded = await session.loadSession(id);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.meta.cwd).toBe("D:\\proj");
  });

  it("updatedAt reflects the file mtime, not creation time", async () => {
    const { id } = await session.createSession("x");
    await new Promise((r) => setTimeout(r, 1100)); // mtime granularity
    await session.appendMessages(id, [{ role: "user", content: "later" }]);
    const file = path.join(fakeHome, ".node-agent", "sessions", `${id}.jsonl`);
    const mtime = (await fs.stat(file)).mtimeMs;
    const loaded = await session.loadSession(id);
    expect(loaded!.meta.updatedAt).toBe(new Date(mtime).toISOString());
    expect(Date.parse(loaded!.meta.updatedAt)).toBeGreaterThan(Date.parse(loaded!.meta.startedAt));
  });

  it("last model marker wins", async () => {
    const { id } = await session.createSession("x");
    await session.appendModel(id, "anthropic:claude-sonnet-4-5");
    await session.appendModel(id, "openai:gpt-4o");
    const loaded = await session.loadSession(id);
    expect(loaded?.meta.model).toBe("openai:gpt-4o");
  });

  it("skips corrupt lines instead of failing", async () => {
    const { id } = await session.createSession("x");
    const file = path.join(fakeHome, ".node-agent", "sessions", `${id}.jsonl`);
    await fs.appendFile(file, "not json\n{also broken\n");
    await session.appendMessages(id, [{ role: "user", content: "ok" }]);
    const loaded = await session.loadSession(id);
    expect(loaded?.messages).toHaveLength(1);
  });

  it("returns null for unknown sessions", async () => {
    expect(await session.loadSession("deadbeef")).toBeNull();
  });
});

describe("listSessions", () => {
  it("lists sessions sorted by updatedAt descending", async () => {
    const a = await session.createSession("a");
    await new Promise((r) => setTimeout(r, 1100));
    const b = await session.createSession("b");
    await new Promise((r) => setTimeout(r, 1100));
    const c = await session.createSession("c");

    const list = await session.listSessions();
    const ids = list.map((s) => s.id);
    expect(ids.indexOf(c.id)).toBeLessThan(ids.indexOf(b.id));
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });
});
