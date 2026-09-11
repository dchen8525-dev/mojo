import type { ServerResponse } from "node:http";

/**
 * Broadcasts server-sent events to every connected GUI client. The hub is
 * transport-only: the caller decides what events mean.
 */
export class SseHub {
  private clients = new Set<ServerResponse>();
  private heartbeat?: NodeJS.Timeout;
  /** Fired when the last client disconnects (used to flush stuck permission prompts). */
  onEmpty?: () => void;

  add(res: ServerResponse): void {
    this.clients.add(res);
    if (!this.heartbeat) {
      // Comment frames keep proxies from buffering and detect dead tabs.
      this.heartbeat = setInterval(() => this.broadcastRaw(": ping\n\n"), 15_000);
      this.heartbeat.unref?.();
    }
    res.on("close", () => this.remove(res));
  }

  remove(res: ServerResponse): void {
    this.clients.delete(res);
    if (!this.clients.size) {
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
      this.onEmpty?.();
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Send a named event with a JSON payload to every client. */
  broadcast(event: string, data: unknown): void {
    this.broadcastRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcastRaw(frame: string): void {
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  closeAll(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
