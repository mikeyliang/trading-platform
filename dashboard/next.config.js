/** @type {import('next').NextConfig} */

// The browser talks only to the dashboard's own origin; these rewrites relay
// API traffic to the backend container server-side. This keeps every request
// same-origin so it works through a single Coder URL (no second port to
// expose, and no cross-origin XHR for Coder's per-port auth to block). The
// target is the API service on the compose network; override for other setups.
const API_TARGET = process.env.API_PROXY_TARGET || "http://trading-api:8000";

const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_TARGET}/api/:path*` },
      { source: "/health", destination: `${API_TARGET}/health` },
    ];
  },
};

module.exports = nextConfig;
