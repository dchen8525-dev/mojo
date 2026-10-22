import { describe, expect, it, vi } from "vitest";
import { MAX_RUNTIME_COMMANDS, RuntimeCommandQueue } from "../src/runtimeQueue.js";

describe("RuntimeCommandQueue", () => {
  it("enqueues with ids and accepted status, FIFO on take", () => {
    const q = new RuntimeCommandQueue();
    const a = q.enqueue("send_prompt", "first", "gui")!;
    const b = q.enqueue("send_prompt", "second", "gui")!;
    expect(a.status).toBe("accepted");
    expect(b.id).not.toBe(a.id);
    const t1 = q.take("send_prompt")!;
    expect(t1.prompt).toBe("first");
    expect(t1.status).toBe("running");
    const t2 = q.take("send_prompt")!;
    expect(t2.prompt).toBe("second");
    expect(q.take("send_prompt")).toBeUndefined();
  });

  it("keeps steer and send_prompt queues separate", () => {
    const q = new RuntimeCommandQueue();
    q.enqueue("steer", "nudge", "agent");
    q.enqueue("send_prompt", "later", "gui");
    expect(q.take("steer")!.prompt).toBe("nudge");
    expect(q.take("steer")).toBeUndefined();
    expect(q.take("send_prompt")!.prompt).toBe("later");
  });

  it("completes commands as done or failed", () => {
    const q = new RuntimeCommandQueue();
    const a = q.enqueue("send_prompt", "x", "gui")!;
    q.take("send_prompt");
    q.complete(a.id);
    expect(q.list().find((c) => c.id === a.id)!.status).toBe("done");
    const b = q.enqueue("send_prompt", "y", "gui")!;
    q.take("send_prompt");
    q.complete(b.id, "boom");
    const rec = q.list().find((c) => c.id === b.id)!;
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe("boom");
  });

  it("cancels accepted commands but not running ones", () => {
    const q = new RuntimeCommandQueue();
    const a = q.enqueue("send_prompt", "pending", "gui")!;
    const b = q.enqueue("send_prompt", "running", "gui")!;
    q.take("send_prompt"); // a is now running
    expect(q.cancel(a.id)).toBe(false);
    expect(q.cancel(b.id)).toBe(true);
    expect(q.list().find((c) => c.id === b.id)!.status).toBe("cancelled");
    expect(q.list().find((c) => c.id === a.id)!.status).toBe("running");
  });

  it("cancelAll cancels only accepted commands of the given type", () => {
    const q = new RuntimeCommandQueue();
    q.enqueue("steer", "s1", "agent");
    q.enqueue("send_prompt", "p1", "gui");
    const p2 = q.enqueue("send_prompt", "p2", "gui")!;
    q.take("send_prompt"); // p1 running
    expect(q.cancelAll("send_prompt")).toBe(1);
    expect(q.list().find((c) => c.id === p2.id)!.status).toBe("cancelled");
    expect(q.list().find((c) => c.prompt === "s1")!.status).toBe("accepted");
    expect(q.list().find((c) => c.prompt === "p1")!.status).toBe("running");
  });

  it("rejects enqueue past the cap with null", () => {
    const q = new RuntimeCommandQueue();
    for (let i = 0; i < MAX_RUNTIME_COMMANDS; i++) {
      expect(q.enqueue("send_prompt", `m${i}`, "gui")).not.toBeNull();
    }
    expect(q.enqueue("send_prompt", "overflow", "gui")).toBeNull();
  });

  it("prunes settled history but never live commands", () => {
    const q = new RuntimeCommandQueue();
    for (let i = 0; i < MAX_RUNTIME_COMMANDS; i++) {
      const c = q.enqueue("send_prompt", `m${i}`, "gui")!;
      q.take("send_prompt");
      q.complete(c.id);
    }
    // All settled; the live set is empty so history stays capped.
    expect(q.list().length).toBe(MAX_RUNTIME_COMMANDS);
    const live = q.enqueue("send_prompt", "live", "gui")!;
    expect(q.list().find((c) => c.id === live.id)!.status).toBe("accepted");
    expect(q.list().length).toBe(MAX_RUNTIME_COMMANDS); // settled trimmed to make room
    expect(q.list().find((c) => c.id === live.id)).toBeDefined();
  });

  it("fires onChange on lifecycle transitions", () => {
    const onChange = vi.fn();
    const q = new RuntimeCommandQueue(onChange);
    const c = q.enqueue("send_prompt", "x", "gui")!;
    expect(onChange).toHaveBeenCalledTimes(1);
    q.take("send_prompt");
    expect(onChange).toHaveBeenCalledTimes(2);
    q.complete(c.id);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("list returns copies, not live records", () => {
    const q = new RuntimeCommandQueue();
    q.enqueue("send_prompt", "x", "gui");
    const snapshot = q.list();
    snapshot[0].status = "done";
    expect(q.list()[0].status).toBe("accepted");
  });
});
