"""Stripe billing for credit packs — raw HTTPS, no SDK dependency.

Two modes, switched by ``settings.stripe_secret_key``:

  * **Dev mode** (no key): packs grant instantly so the product is fully
    usable without a Stripe account.
  * **Stripe mode**: ``create_checkout_session`` builds a hosted
    Checkout page and the grant happens only when Stripe confirms
    payment via the ``checkout.session.completed`` webhook (verified
    with the signing secret, granted idempotently per session id).

Uses Stripe's form-encoded REST API directly via httpx — one less
dependency to ship, and the two calls we need are stable v1 endpoints.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any, Dict, Optional

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

_STRIPE_API = "https://api.stripe.com/v1"
_TIMEOUT_S = 20
# Reject webhook events whose signature timestamp is older than this —
# limits replay of captured payloads.
_SIGNATURE_TOLERANCE_S = 300


class BillingError(Exception):
    pass


def stripe_enabled() -> bool:
    return bool(settings.stripe_secret_key)


async def create_checkout_session(
    user_id: str, pack_id: str, pack_name: str, credits_amount: int, price_usd: float
) -> str:
    """Create a hosted Checkout Session and return its URL."""
    base = settings.public_base_url.rstrip("/")
    form = {
        "mode": "payment",
        "success_url": f"{base}/research/pricing?checkout=success",
        "cancel_url": f"{base}/research/pricing?checkout=cancelled",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": str(int(round(price_usd * 100))),
        "line_items[0][price_data][product_data][name]": f"{pack_name} — {credits_amount} research credits",
        "metadata[user_id]": user_id,
        "metadata[pack_id]": pack_id,
        "metadata[credits]": str(credits_amount),
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.post(
                f"{_STRIPE_API}/checkout/sessions",
                auth=(settings.stripe_secret_key, ""),
                data=form,
            )
    except httpx.HTTPError as e:
        raise BillingError(f"stripe unreachable: {e}") from e
    if resp.status_code != 200:
        logger.error("stripe checkout create failed: %s %s", resp.status_code, resp.text[:300])
        raise BillingError(f"stripe error {resp.status_code}")
    return resp.json()["url"]


def verify_webhook_signature(payload: bytes, signature_header: str) -> bool:
    """Verify a ``Stripe-Signature`` header against the signing secret.

    Header format: ``t=<unix>,v1=<hex hmac>[,v1=...]``. The signed
    message is ``f"{t}.{raw_body}"`` HMAC-SHA256'd with the secret.
    """
    secret = settings.stripe_webhook_secret
    if not secret:
        return False
    parts: Dict[str, list] = {}
    for item in signature_header.split(","):
        if "=" not in item:
            continue
        k, v = item.split("=", 1)
        parts.setdefault(k.strip(), []).append(v.strip())
    timestamps = parts.get("t", [])
    candidates = parts.get("v1", [])
    if not timestamps or not candidates:
        return False
    try:
        ts = int(timestamps[0])
    except ValueError:
        return False
    if abs(time.time() - ts) > _SIGNATURE_TOLERANCE_S:
        return False
    signed = f"{timestamps[0]}.".encode() + payload
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, c) for c in candidates)


def parse_completed_checkout(payload: bytes) -> Optional[Dict[str, Any]]:
    """Extract the grant details from a ``checkout.session.completed``
    event, or None for event types we don't act on."""
    try:
        event = json.loads(payload)
    except json.JSONDecodeError:
        return None
    if event.get("type") != "checkout.session.completed":
        return None
    session = (event.get("data") or {}).get("object") or {}
    meta = session.get("metadata") or {}
    user_id = meta.get("user_id")
    pack_id = meta.get("pack_id")
    try:
        credits_amount = int(meta.get("credits", ""))
    except (TypeError, ValueError):
        credits_amount = 0
    if not user_id or not pack_id or credits_amount <= 0:
        return None
    return {
        "session_id": session.get("id", ""),
        "user_id": user_id,
        "pack_id": pack_id,
        "credits": credits_amount,
    }
