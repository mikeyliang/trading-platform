/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy API + WS through the dashboard's own origin so the browser doesn't
  // have to know where the API lives. Critical for Coder / Codespaces / any
  // port-forwarded setup where ports 3000 and 8000 reach the user through
  // different hostnames — same-origin requests Just Work.
  async rewrites() {
    const apiUrl = process.env.API_URL || "http://localhost:8000";
    return [
      { source: "/api/:path*",     destination: `${apiUrl}/api/:path*` },
      { source: "/health",          destination: `${apiUrl}/health` },
      { source: "/ws",              destination: `${apiUrl}/ws` },
      // Per-symbol depth + tape streams. Next.js dev can't proxy upgrades,
      // so the browser-side ws helper rewrites these to the API origin on
      // Coder/port-forwarded setups (see lib/ws-stream.ts).
      { source: "/api/depth/ws/:symbol",  destination: `${apiUrl}/api/depth/ws/:symbol` },
      { source: "/api/ticks/ws/:symbol",  destination: `${apiUrl}/api/ticks/ws/:symbol` },
    ];
  },
};

module.exports = nextConfig;
