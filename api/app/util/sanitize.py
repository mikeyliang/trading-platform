"""
String input sanitization helpers.

Two failure modes we care about:

1. Null bytes (``\\x00``) — Postgres rejects strings containing them, and some
   downstream libraries treat them as terminators. A request that smuggles in
   a null byte can crash a worker or truncate a logged value.

2. Unbounded length — pydantic will happily validate a 50 MB string field.
   Cap inputs early so an attacker can't allocate gigabytes by spamming
   long query params.

We deliberately do NOT HTML-escape: this API returns JSON, not HTML, and
escaping every string would corrupt symbols / order tickets that legitimately
contain ``<``, ``&``, etc.
"""
from __future__ import annotations

from typing import Any


# Allow common whitespace (tab, newline, carriage return) — strip every other
# C0 control. Removing \n outright would mangle multi-line chat prompts.
_ALLOWED_CONTROLS = {"\t", "\n", "\r"}


def sanitize_string(value: str, max_length: int = 10_000) -> str:
    """Strip null bytes and disallowed control chars, then truncate.

    Truncation is silent — callers that need to reject oversized input
    should length-check before calling.
    """
    if not value:
        return value
    cleaned = "".join(
        ch for ch in value
        if ch in _ALLOWED_CONTROLS or ord(ch) >= 0x20
    )
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length]
    return cleaned


def sanitize_value(value: Any, max_length: int = 10_000) -> Any:
    """Recursively sanitize strings inside arbitrary JSON-like structures.

    Non-string scalars (int/float/bool/None) pass through untouched.
    """
    if isinstance(value, str):
        return sanitize_string(value, max_length=max_length)
    if isinstance(value, dict):
        return {k: sanitize_value(v, max_length=max_length) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_value(v, max_length=max_length) for v in value]
    if isinstance(value, tuple):
        return tuple(sanitize_value(v, max_length=max_length) for v in value)
    return value
