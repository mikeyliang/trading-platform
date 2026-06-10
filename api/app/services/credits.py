"""Credit accounts + ledger for the equity research desk.

Every research run debits credits; plan subscriptions and pack
purchases credit them. Persistence is Postgres when available, with an
in-process fallback (dev / CI) so the feature works without a database
— balances just don't survive restarts.

Stripe is intentionally stubbed: ``checkout`` grants instantly when no
``stripe_secret_key`` is configured. Wiring real Stripe means creating
a Checkout Session here and moving the ``grant`` call into the webhook
handler that confirms payment.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional, TypedDict

from ..config import settings
from . import db

logger = logging.getLogger(__name__)


class InsufficientCreditsError(Exception):
    def __init__(self, balance: int, needed: int):
        super().__init__(f"insufficient credits: have {balance}, need {needed}")
        self.balance = balance
        self.needed = needed


class Plan(TypedDict):
    id: str
    name: str
    price_usd_month: float
    credits_month: int
    blurb: str
    features: List[str]


class CreditPack(TypedDict):
    id: str
    name: str
    credits: int
    price_usd: float


PLANS: List[Plan] = [
    {
        "id": "free",
        "name": "Free",
        "price_usd_month": 0.0,
        "credits_month": 0,
        "blurb": "Kick the tires — signup credits included.",
        "features": [
            f"{settings.free_signup_credits} credits on signup",
            "Quick analyses on stocks, ETFs & crypto",
            "Run history (last 20 runs)",
        ],
    },
    {
        "id": "pro",
        "name": "Pro",
        "price_usd_month": 39.0,
        "credits_month": 400,
        "blurb": "For active traders running daily research.",
        "features": [
            "400 credits / month",
            "All analyst agents + bull/bear debate",
            "Deep runs with risk committee",
            "Full run history",
        ],
    },
    {
        "id": "desk",
        "name": "Desk",
        "price_usd_month": 199.0,
        "credits_month": 2500,
        "blurb": "Team-grade volume for funds and prop desks.",
        "features": [
            "2,500 credits / month",
            "Everything in Pro",
            "Priority model capacity",
            "Credit rollover (1 month)",
        ],
    },
]

CREDIT_PACKS: List[CreditPack] = [
    {"id": "starter", "name": "Starter pack", "credits": 100, "price_usd": 15.0},
    {"id": "trader", "name": "Trader pack", "credits": 500, "price_usd": 59.0},
    {"id": "fund", "name": "Fund pack", "credits": 2000, "price_usd": 199.0},
]


# ── in-memory fallback (no postgres) ─────────────────────────────────

_mem_accounts: Dict[str, Dict] = {}
_mem_ledger: List[Dict] = []


def _mem_account(user_id: str) -> Dict:
    acct = _mem_accounts.get(user_id)
    if acct is None:
        acct = {"user_id": user_id, "plan": "free", "balance": settings.free_signup_credits}
        _mem_accounts[user_id] = acct
        _mem_ledger.append({
            "user_id": user_id, "delta": settings.free_signup_credits,
            "balance_after": acct["balance"], "reason": "signup_grant",
        })
    return acct


def reset_memory_store() -> None:
    """Test helper — wipe the in-memory fallback."""
    _mem_accounts.clear()
    _mem_ledger.clear()


# ── public API ───────────────────────────────────────────────────────

async def get_account(user_id: str) -> Dict:
    """Fetch (auto-creating with the signup grant) the user's account."""
    pool = db.pool()
    if pool is None:
        acct = _mem_account(user_id)
        return {"user_id": user_id, "plan": acct["plan"], "balance": acct["balance"]}
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT user_id, plan, balance FROM credit_accounts WHERE user_id = $1", user_id
        )
        if row is None:
            row = await conn.fetchrow(
                """
                INSERT INTO credit_accounts (user_id, plan, balance)
                VALUES ($1, 'free', $2)
                ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
                RETURNING user_id, plan, balance
                """,
                user_id, settings.free_signup_credits,
            )
            await conn.execute(
                """
                INSERT INTO credit_ledger (user_id, delta, balance_after, reason)
                VALUES ($1, $2, $3, 'signup_grant')
                """,
                user_id, settings.free_signup_credits, int(row["balance"]),
            )
        return {"user_id": row["user_id"], "plan": row["plan"], "balance": int(row["balance"])}


async def adjust(user_id: str, delta: int, reason: str) -> int:
    """Apply a signed credit delta. Raises InsufficientCreditsError if
    the debit would take the balance negative. Returns the new balance."""
    await get_account(user_id)  # ensure the account exists
    pool = db.pool()
    if pool is None:
        acct = _mem_account(user_id)
        new_balance = acct["balance"] + delta
        if new_balance < 0:
            raise InsufficientCreditsError(acct["balance"], -delta)
        acct["balance"] = new_balance
        _mem_ledger.append({
            "user_id": user_id, "delta": delta,
            "balance_after": new_balance, "reason": reason,
        })
        return new_balance
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT balance FROM credit_accounts WHERE user_id = $1 FOR UPDATE", user_id
            )
            balance = int(row["balance"])
            new_balance = balance + delta
            if new_balance < 0:
                raise InsufficientCreditsError(balance, -delta)
            await conn.execute(
                "UPDATE credit_accounts SET balance = $2, updated_at = NOW() WHERE user_id = $1",
                user_id, new_balance,
            )
            await conn.execute(
                """
                INSERT INTO credit_ledger (user_id, delta, balance_after, reason)
                VALUES ($1, $2, $3, $4)
                """,
                user_id, delta, new_balance, reason,
            )
    return new_balance


async def ledger(user_id: str, limit: int = 50) -> List[Dict]:
    pool = db.pool()
    if pool is None:
        rows = [e for e in _mem_ledger if e["user_id"] == user_id]
        return list(reversed(rows[-limit:]))
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT delta, balance_after, reason, created_at
            FROM credit_ledger WHERE user_id = $1
            ORDER BY id DESC LIMIT $2
            """,
            user_id, limit,
        )
    return [
        {
            "delta": int(r["delta"]),
            "balance_after": int(r["balance_after"]),
            "reason": r["reason"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


async def has_ledger_reason(reason: str) -> bool:
    """True if any ledger entry carries this reason — used to make
    webhook grants idempotent (reason embeds the Stripe session id)."""
    pool = db.pool()
    if pool is None:
        return any(e["reason"] == reason for e in _mem_ledger)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT 1 FROM credit_ledger WHERE reason = $1 LIMIT 1", reason
        )
    return row is not None


async def set_plan(user_id: str, plan_id: str) -> None:
    await get_account(user_id)
    pool = db.pool()
    if pool is None:
        _mem_account(user_id)["plan"] = plan_id
        return
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE credit_accounts SET plan = $2, updated_at = NOW() WHERE user_id = $1",
            user_id, plan_id,
        )


def pack_by_id(pack_id: str) -> Optional[CreditPack]:
    return next((p for p in CREDIT_PACKS if p["id"] == pack_id), None)


def plan_by_id(plan_id: str) -> Optional[Plan]:
    return next((p for p in PLANS if p["id"] == plan_id), None)
