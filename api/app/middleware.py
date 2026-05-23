"""
HTTP middleware: rate limiting, request logging, query-param sanitization.

In-process / single-worker. For a multi-worker uvicorn or multi-pod deploy,
swap the in-memory rate-limit store for Redis — the public interface stays
the same.
"""
from __future__ import annotations

import logging
import time
import uuid
from collections import defaultdict, deque
from threading import Lock
from typing import Deque, Iterable

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from .util.sanitize import sanitize_string

logger = logging.getLogger(__name__)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window per-IP rate limiter.

    Keeps a deque of recent request timestamps per client. On each request,
    drops timestamps older than the window and counts what's left. Returns
    HTTP 429 once the count exceeds ``max_requests``.

    Memory is bounded by total active client IPs — buckets are pruned when
    they fall fully outside the window during a request that touches them.
    """

    def __init__(
        self,
        app: ASGIApp,
        max_requests: int,
        window_seconds: int,
        exempt_paths: Iterable[str] = (),
    ):
        super().__init__(app)
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.exempt_paths = {p.strip() for p in exempt_paths if p and p.strip()}
        self._buckets: dict[str, Deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def _client_key(self, request: Request) -> str:
        # Honor X-Forwarded-For when running behind a reverse proxy. Falls
        # back to the direct peer; ``request.client`` can be None for ASGI
        # transports without a peer address.
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    async def dispatch(self, request: Request, call_next):
        if request.url.path in self.exempt_paths:
            return await call_next(request)

        key = self._client_key(request)
        now = time.monotonic()
        cutoff = now - self.window_seconds

        with self._lock:
            bucket = self._buckets[key]
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= self.max_requests:
                retry_after = max(1, int(self.window_seconds - (now - bucket[0])))
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": "RateLimitExceeded",
                        "message": f"Too many requests. Try again in {retry_after}s.",
                        "details": {
                            "limit": self.max_requests,
                            "window_seconds": self.window_seconds,
                        },
                    },
                    headers={"Retry-After": str(retry_after)},
                )
            bucket.append(now)
            if not bucket:
                self._buckets.pop(key, None)

        return await call_next(request)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Logs one line per request with method, path, status, latency, and a
    short request ID (also echoed in the ``X-Request-ID`` response header so
    clients can quote it when reporting issues).
    """

    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        start = time.monotonic()
        client = request.client.host if request.client else "-"
        try:
            response = await call_next(request)
        except Exception:
            elapsed_ms = (time.monotonic() - start) * 1000
            logger.exception(
                "request %s %s %s failed after %.1fms (rid=%s)",
                client, request.method, request.url.path, elapsed_ms, request_id,
            )
            raise

        elapsed_ms = (time.monotonic() - start) * 1000
        # WARN on 5xx, INFO otherwise — keeps the happy path quiet.
        log_fn = logger.warning if response.status_code >= 500 else logger.info
        log_fn(
            "%s %s %s -> %s (%.1fms) rid=%s",
            client, request.method, request.url.path,
            response.status_code, elapsed_ms, request_id,
        )
        response.headers["X-Request-ID"] = request_id
        return response


class QueryParamSanitizationMiddleware(BaseHTTPMiddleware):
    """Reject requests whose query parameters contain null bytes or exceed
    the configured length cap.

    Body sanitization is left to pydantic validators on individual routes —
    parsing the body here would force us to buffer arbitrary payloads.
    """

    def __init__(self, app: ASGIApp, max_string_length: int):
        super().__init__(app)
        self.max_string_length = max_string_length

    async def dispatch(self, request: Request, call_next):
        for key, value in request.query_params.multi_items():
            if "\x00" in key or "\x00" in value:
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": "InvalidInput",
                        "message": "Null bytes are not allowed in query parameters.",
                    },
                )
            if len(value) > self.max_string_length:
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": "InvalidInput",
                        "message": f"Query parameter '{key}' exceeds max length of {self.max_string_length}.",
                    },
                )
            cleaned = sanitize_string(value, max_length=self.max_string_length)
            if cleaned != value:
                # Stripped control chars — log but don't 400; this is usually
                # an over-eager client copy/paste rather than an attack.
                logger.debug("sanitized control chars from query param %s", key)
        return await call_next(request)
