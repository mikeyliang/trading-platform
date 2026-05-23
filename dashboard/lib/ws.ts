import type { WSMessage } from "@/types";

/** Resolve the WS endpoint at connect time so we use whatever origin the
 * browser is already talking to. Handles three deployment shapes:
 *   1. localhost dev   → ws://localhost:8000/ws  (env override)
 *   2. Next.js + nginx → wss://<same-host>/ws    (relative)
 *   3. Coder / port-forwarded — dashboard at `3000--…` host, API at `8000--…`
 *      Same-origin WS doesn't work because Next dev server can't proxy WS
 *      upgrades, so we rewrite the port-prefix to hit the API directly. */
function resolveWsUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_WS_URL;
  if (fromEnv) return fromEnv;
  if (typeof window === "undefined") return "ws://localhost:8000/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  // Coder / Codespaces-style port prefix: `3000--<workspace>...` → `8000--<workspace>...`
  const portPrefixed = host.match(/^(\d+)(--.*)$/);
  if (portPrefixed) {
    return `${proto}//8000${portPrefixed[2]}/ws`;
  }
  return `${proto}//${host}/ws`;
}

type Handler = (msg: WSMessage) => void;

class TradingWebSocket {
  private ws: WebSocket | null = null;
  private handlers: Set<Handler> = new Set();
  private delay = 2000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  connect() {
    if (typeof window === "undefined") return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.closing = false;
    try {
      this.ws = new WebSocket(resolveWsUrl());
      this.ws.onopen = () => {
        this.delay = 2000;
        this.fire({ type: "connected" });
      };
      this.ws.onmessage = (e) => {
        try { this.fire(JSON.parse(e.data)); } catch (_) { /* skip */ }
      };
      this.ws.onclose = () => {
        this.fire({ type: "disconnected" });
        if (!this.closing) this.reconnect();
      };
      this.ws.onerror = () => this.ws?.close();
    } catch (_) { /* ignore */ }
  }

  disconnect() {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  subscribe(symbols: string[]) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "subscribe", symbols }));
    }
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private fire(msg: WSMessage) {
    this.handlers.forEach((h) => h(msg));
  }

  private reconnect() {
    this.timer = setTimeout(() => {
      this.delay = Math.min(this.delay * 1.5, 30000);
      this.connect();
    }, this.delay);
  }
}

export const ws = new TradingWebSocket();
