import type { WSMessage } from "@/types";

/** Resolve the WS endpoint at connect time. Always same-origin: the custom
 * Next server (server.js) relays the `/ws` upgrade to the API, so the browser
 * never opens a cross-origin socket to the API's port — which Coder's per-port
 * auth would block. Override with NEXT_PUBLIC_WS_URL for localhost dev against
 * a separately-hosted API. */
function resolveWsUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_WS_URL;
  if (fromEnv) return fromEnv;
  if (typeof window === "undefined") return "ws://localhost:8000/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
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
