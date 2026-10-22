import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { SseHub } from "../src/gui/sse.js";

class FakeRes extends EventEmitter {
  writableLength = 0;
  written: string[] = [];
  destroyed = false;

  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }

  end(): void {}

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

describe("SseHub", () => {
  it("broadcasts to a healthy client", () => {
    const hub = new SseHub();
    const res = new FakeRes();
    hub.add(res as never);
    try {
      hub.broadcast("round_start", { round: 1 });
      expect(res.written.join("")).toContain("event: round_start");
      expect(hub.clientCount).toBe(1);
    } finally {
      hub.closeAll();
    }
  });

  it("drops a client whose output backlog exceeds the cap", () => {
    const hub = new SseHub();
    const slow = new FakeRes();
    slow.writableLength = 5 * 1024 * 1024;
    const fast = new FakeRes();
    let emptied = 0;
    hub.onEmpty = () => emptied++;
    hub.add(slow as never);
    hub.add(fast as never);
    try {
      hub.broadcast("turn_start", { turnId: 1 });
      expect(slow.written).toEqual([]);
      expect(slow.destroyed).toBe(true);
      expect(hub.clientCount).toBe(1);
      expect(fast.written.join("")).toContain("event: turn_start");
      expect(emptied).toBe(0);
    } finally {
      hub.closeAll();
    }
  });

  it("notifies when the last client goes away", () => {
    const hub = new SseHub();
    const res = new FakeRes();
    let emptied = 0;
    hub.onEmpty = () => emptied++;
    hub.add(res as never);
    hub.remove(res as never);
    expect(hub.clientCount).toBe(0);
    expect(emptied).toBe(1);
  });
});
