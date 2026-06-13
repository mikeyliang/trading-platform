/** Resolve the REST API base URL at call time.
 *
 * The browser ALWAYS talks to the dashboard's own origin (same-origin ""):
 * the Next.js rewrites in next.config.js proxy `/api/*` and `/health` to the
 * backend container. This deliberately avoids cross-origin requests to the
 * API on a second port — under Coder, `3000--…` → `8000--…` is cross-origin
 * and Coder's per-port auth intercepts the XHR (redirect to auth) so it fails
 * with a CORS error even though the API itself sends `Access-Control-Allow-
 * Origin: *`. Routing everything through the one origin the user is already
 * authenticated on sidesteps that entirely and needs no second port exposed.
 *
 * Override with NEXT_PUBLIC_API_URL only for localhost dev against a
 * separately-hosted API (e.g. http://localhost:8000).
 *
 * Returns a base with no trailing slash, or "" for same-origin. */
export function resolveApiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_URL;
  if (fromEnv) return fromEnv;
  return "";
}
