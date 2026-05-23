"use client";

import { useEffect, useState } from "react";

const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

async function check(): Promise<boolean> {
  if (cached !== null) return cached;
  if (inflight) return inflight;
  inflight = fetch(`${BASE}/api/chat/status`)
    .then((r) => r.json())
    .then((j) => {
      cached = !!j.available;
      inflight = null;
      return cached;
    })
    .catch(() => {
      cached = false;
      inflight = null;
      return false;
    });
  return inflight;
}

/**
 * Returns whether the AI co-pilot is enabled. Cached for the session.
 * - `null` while loading on first mount
 * - `true` if ANTHROPIC_API_KEY is set server-side
 * - `false` otherwise
 *
 * Components should hide all chat affordances when this returns false.
 */
export function useChatAvailable(): boolean | null {
  const [avail, setAvail] = useState<boolean | null>(cached);
  useEffect(() => {
    if (cached !== null) return;
    let alive = true;
    check().then((v) => {
      if (alive) setAvail(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return avail;
}
