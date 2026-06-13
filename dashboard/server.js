/**
 * Custom Next.js server.
 *
 * Why this exists: the browser only ever talks to the dashboard's own origin
 * (see lib/api-base.ts and the next.config.js rewrites). Plain `next dev`
 * cannot proxy WebSocket upgrades, so live streams used to connect cross-origin
 * to the API's `8000--…` port — which Coder's per-port auth blocks. This server
 * keeps everything same-origin by relaying WS upgrades for the API's socket
 * endpoints to the backend container, while delegating HTTP (and Next's own HMR
 * socket at /_next/webpack-hmr) to Next as usual.
 *
 * The WS relay is a raw TCP pipe using only Node built-ins (no extra
 * dependency): on upgrade we open a socket to the API, replay the handshake
 * request bytes, and pipe both directions. The 101 response and all frames
 * flow through untouched.
 */
const { createServer } = require("http");
const { parse } = require("url");
const net = require("net");
const next = require("next");

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3000", 10);

// API_PROXY_TARGET mirrors next.config.js. Strip scheme; default to the
// compose service. host:port split tolerates a missing port.
const rawTarget = (process.env.API_PROXY_TARGET || "http://trading-api:8000").replace(/^https?:\/\//, "");
const [apiHost, apiPortStr] = rawTarget.split(":");
const apiPort = parseInt(apiPortStr || "8000", 10);

// Paths whose WS upgrades belong to the API, not to Next.
function isApiWs(pathname) {
  return (
    pathname === "/ws" ||
    pathname.startsWith("/api/ws/") ||
    pathname.startsWith("/api/depth/ws/") ||
    pathname.startsWith("/api/ticks/ws/")
  );
}

const app = next({ dev, hostname: "0.0.0.0", port });
const handle = app.getRequestHandler();
const upgradeHandler = app.getUpgradeHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res, parse(req.url, true)));

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url);

    if (!isApiWs(pathname)) {
      // Next.js HMR (/_next/webpack-hmr) and anything else.
      upgradeHandler(req, socket, head);
      return;
    }

    const upstream = net.connect(apiPort, apiHost, () => {
      let handshake = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        handshake += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      handshake += "\r\n";
      upstream.write(handshake);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    const teardown = (err) => {
      if (err) console.error(`[ws-proxy] ${pathname}: ${err.message}`);
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", teardown);
    socket.on("error", teardown);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`> dashboard ready on http://0.0.0.0:${port}  (API ws → ${apiHost}:${apiPort})`);
  });
});
