"""Stock-logo endpoint.

``GET /api/logos/{symbol}`` returns a PNG (or whatever image format the
remote source provided). Cached in MinIO; on miss we negative-cache for a
day so we don't spam the public sources. Clients should treat 404 as
"render the initials fallback".
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Response

from ..services import logo_store

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/logos", tags=["logos"])


@router.get("/{symbol}")
async def get_logo(symbol: str):
    data = await logo_store.get_logo(symbol)
    if not data:
        return Response(status_code=404)
    # Browsers + fetch() both honor this. Cache-Control keeps the
    # round-trip cost low on subsequent renders of the same symbol.
    media = "image/png"
    if data[:2] == b"\xff\xd8":
        media = "image/jpeg"
    elif data[:4] in (b"GIF8", b"RIFF"):
        media = "image/gif"
    return Response(
        content=data,
        media_type=media,
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )
