/** Per-stream WebSocket helper for `/api/depth/ws/{symbol}` and `/api/ticks/ws/{symbol}`.
 *
 * Always same-origin: the custom Next server (server.js) relays these upgrades
 * to the API, so the browser never opens a cross-origin socket to the API's
 * port (which Coder's per-port auth would block). */

export interface StreamMessage {
  type: string;
  data?: unknown;
}

function resolveStreamUrl(path: string): string {
  if (typeof window === "undefined") return `ws://localhost:8000${path}`;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

type Handler = (msg: StreamMessage) => void;

export class StreamWebSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private path: string;
  private delay = 1500;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  constructor(path: string) {
    this.path = path;
  }

  connect() {
    if (typeof window === "undefined") return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.closing = false;
    try {
      this.ws = new WebSocket(resolveStreamUrl(this.path));
      this.ws.onopen = () => {
        this.delay = 1500;
        this.fire({ type: "open" });
      };
      this.ws.onmessage = (e) => {
        try { this.fire(JSON.parse(e.data)); } catch { /* skip */ }
      };
      this.ws.onclose = () => {
        this.fire({ type: "close" });
        if (!this.closing) this.reconnect();
      };
      this.ws.onerror = () => this.ws?.close();
    } catch { /* ignore */ }
  }

  disconnect() {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  on(h: Handler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  private fire(msg: StreamMessage) {
    this.handlers.forEach((h) => h(msg));
  }

  private reconnect() {
    this.timer = setTimeout(() => {
      this.delay = Math.min(this.delay * 1.5, 20000);
      this.connect();
    }, this.delay);
  }
}
