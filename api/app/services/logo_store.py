"""Stock-logo cache backed by MinIO.

Logos are fetched lazily on first request from public sources and cached
in the ``logos`` bucket. Subsequent requests hit MinIO directly. When the
remote source has no image we cache a "miss" marker for a short window so
we don't keep re-asking — the frontend falls back to its initials bubble.

Public sources tried in order:
  1. Financial Modeling Prep image-stock (good major-market coverage)
  2. Parqet CDN (broad coverage, German fintech's public asset host)
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional, Tuple

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

# In-process memo: PNG bytes or ``b""`` (miss marker). Keyed by uppercase
# symbol; survives until process restart, before falling through to MinIO.
_mem_cache: dict[str, Tuple[float, Optional[bytes]]] = {}
_MEM_TTL = 600  # seconds
_MISS_TTL = 86400  # seconds — cache 404s for a day in MinIO too

_REMOTE_SOURCES = [
    "https://financialmodelingprep.com/image-stock/{symbol}.png",
    "https://assets.parqet.com/logos/symbol/{symbol}",
]


# ────── MinIO ──────────────────────────────────────────────────────────────
_s3_client = None
_bucket_ensured = False


def _s3():
    """Lazy boto3 client. Returns None if boto3 isn't installed (degrade
    gracefully)."""
    global _s3_client
    if _s3_client is not None:
        return _s3_client
    try:
        import boto3
        from botocore.client import Config
        _s3_client = boto3.client(
            "s3",
            endpoint_url=settings.minio_endpoint,
            aws_access_key_id=settings.minio_access_key,
            aws_secret_access_key=settings.minio_secret_key,
            config=Config(signature_version="s3v4", retries={"max_attempts": 1}),
            region_name="us-east-1",
        )
        return _s3_client
    except Exception as e:  # noqa: BLE001
        logger.warning("MinIO client init failed: %s", e)
        return None


def _ensure_bucket() -> bool:
    global _bucket_ensured
    if _bucket_ensured:
        return True
    cli = _s3()
    if cli is None:
        return False
    try:
        cli.head_bucket(Bucket=settings.minio_bucket)
        _bucket_ensured = True
        return True
    except Exception:
        pass
    try:
        cli.create_bucket(Bucket=settings.minio_bucket)
        _bucket_ensured = True
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("MinIO create_bucket failed: %s", e)
        return False


def _minio_get(symbol: str) -> Optional[bytes]:
    cli = _s3()
    if cli is None or not _ensure_bucket():
        return None
    try:
        obj = cli.get_object(Bucket=settings.minio_bucket, Key=_key(symbol))
        return obj["Body"].read()
    except Exception:
        return None


def _minio_put(symbol: str, data: bytes, content_type: str = "image/png") -> None:
    cli = _s3()
    if cli is None or not _ensure_bucket():
        return
    try:
        cli.put_object(
            Bucket=settings.minio_bucket,
            Key=_key(symbol),
            Body=data,
            ContentType=content_type,
            CacheControl="public, max-age=86400",
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("MinIO put failed for %s: %s", symbol, e)


def _key(symbol: str) -> str:
    return f"{symbol.upper()}.png"


def _miss_key(symbol: str) -> str:
    return f"_miss/{symbol.upper()}.txt"


def _is_miss_cached(symbol: str) -> bool:
    """Cached-404 check: don't re-hit upstream sources for unknown tickers
    for ``_MISS_TTL`` seconds."""
    cli = _s3()
    if cli is None:
        return False
    try:
        obj = cli.head_object(Bucket=settings.minio_bucket, Key=_miss_key(symbol))
        ts = float(obj.get("Metadata", {}).get("ts", "0"))
        return (time.time() - ts) < _MISS_TTL
    except Exception:
        return False


def _mark_miss(symbol: str) -> None:
    cli = _s3()
    if cli is None or not _ensure_bucket():
        return
    try:
        cli.put_object(
            Bucket=settings.minio_bucket,
            Key=_miss_key(symbol),
            Body=b"miss",
            Metadata={"ts": str(time.time())},
        )
    except Exception:
        pass


# ────── Public API ─────────────────────────────────────────────────────────

async def get_logo(symbol: str) -> Optional[bytes]:
    """Return PNG bytes for ``symbol``, or None when no logo is available."""
    symbol = symbol.upper().strip()
    if not symbol:
        return None

    # 1. In-process memo
    hit = _mem_cache.get(symbol)
    if hit and (time.time() - hit[0]) < _MEM_TTL:
        return hit[1] or None

    # 2. MinIO
    cached = await asyncio.to_thread(_minio_get, symbol)
    if cached:
        _mem_cache[symbol] = (time.time(), cached)
        return cached

    # 3. Negative cache (don't keep hitting public sources for unknown tickers)
    if await asyncio.to_thread(_is_miss_cached, symbol):
        _mem_cache[symbol] = (time.time(), None)
        return None

    # 4. Fetch from public sources
    fetched = await _fetch_remote(symbol)
    if fetched:
        await asyncio.to_thread(_minio_put, symbol, fetched)
        _mem_cache[symbol] = (time.time(), fetched)
        return fetched

    # 5. Record miss
    await asyncio.to_thread(_mark_miss, symbol)
    _mem_cache[symbol] = (time.time(), None)
    return None


async def _fetch_remote(symbol: str) -> Optional[bytes]:
    async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
        for tmpl in _REMOTE_SOURCES:
            url = tmpl.format(symbol=symbol)
            try:
                r = await client.get(url)
            except Exception:
                continue
            if r.status_code != 200:
                continue
            content = r.content or b""
            # Some providers return a 1×1 placeholder for unknown tickers.
            # Anything under ~500 bytes is almost certainly that.
            if len(content) < 500:
                continue
            ct = r.headers.get("content-type", "")
            if not (ct.startswith("image/") or _looks_like_image(content)):
                continue
            return content
    return None


def _looks_like_image(data: bytes) -> bool:
    return data[:8] in (b"\x89PNG\r\n\x1a\n",) or data[:2] in (b"\xff\xd8",) or data[:4] in (b"GIF8", b"RIFF")
