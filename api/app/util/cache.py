"""
Tiny in-process TTL cache. Used by hot endpoints that hit slow external
data (IBKR historical bars, Chronos model). Avoids per-request
30s timeouts by serving recent results instantly.

Per-process — no Redis, no cross-worker sharing. Good enough for a single
uvicorn worker running a personal trading dashboard.
"""
from __future__ import annotations

import time
from threading import Lock
from typing import Any, Callable, Tuple


class TTLCache:
    def __init__(self, ttl_seconds: float):
        self.ttl = ttl_seconds
        self._store: dict[Any, Tuple[float, Any]] = {}
        self._lock = Lock()

    def get(self, key: Any) -> Any | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at < time.monotonic():
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: Any, value: Any, ttl_seconds: float | None = None) -> None:
        with self._lock:
            ttl = ttl_seconds if ttl_seconds is not None else self.ttl
            self._store[key] = (time.monotonic() + ttl, value)
            # opportunistic GC — keep dict bounded
            if len(self._store) > 1024:
                now = time.monotonic()
                self._store = {k: v for k, v in self._store.items() if v[0] >= now}

    def invalidate(self, key: Any) -> None:
        with self._lock:
            self._store.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


async def memoize_async(cache: TTLCache, key: Any, fn: Callable):
    """Get from cache or run async fn and store. Single-flight is NOT enforced
    here — overlapping requests for the same key may all call fn once until the
    first finishes. For our usage that's acceptable (idempotent, slow path)."""
    hit = cache.get(key)
    if hit is not None:
        return hit
    value = await fn()
    cache.set(key, value)
    return value
