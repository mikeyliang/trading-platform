# Trading Platform

[![CI](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml)
[![Dashboard](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml/badge.svg?event=push&job=dashboard)](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml)
[![API](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml/badge.svg?event=push&job=api)](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml)

A trading platform with a FastAPI backend (`api/`) and a Next.js dashboard (`dashboard/`).

## Equity Research Desk (multi-agent AI)

A TradingAgents-style research product built in: pick a stock, ETF or crypto
token and a team of AI agents produces an accountable trade call —

1. **Analyst team** (market / fundamentals / news / sentiment / on-chain)
   reads the tape concurrently and streams its takes live.
2. **Bull vs bear researchers** debate the analyst reports across rounds.
3. **Trader + risk manager** turn the debate into a stress-tested plan.
4. **Portfolio manager** issues a structured BUY / SELL / HOLD decision with
   conviction, sizing, entry/stop/target and key risks.

Runs are metered in **credits** (priced by agent count × depth) with plans,
credit packs and a Stripe-ready checkout. UI lives at `/research` and
`/research/pricing`; API under `/api/research/*`.

Configuration (env / `.env` in `api/`):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | required — powers the agents |
| `EQUITY_DEEP_MODEL` / `EQUITY_QUICK_MODEL` | model overrides (default `claude-opus-4-8`) |
| `FREE_SIGNUP_CREDITS` | signup grant (default 25) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | enable real Stripe Checkout + webhook grants; unset = dev mode (packs grant instantly) |
| `PUBLIC_BASE_URL` | dashboard origin for checkout redirects |

Market data is free-tier (Stooq daily bars for stocks/ETFs, CoinGecko for
crypto, public RSS for news) so the product works with zero data
subscriptions. Postgres persists runs, credit accounts and the ledger; with
no database the desk still works using an in-process store.

## Layout

- `api/` — FastAPI service (Python 3.11). Entrypoint: `app.main:app`.
- `dashboard/` — Next.js 14 app (TypeScript, Tailwind).

## Local development

```bash
# Backend
cd api && pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# Dashboard
cd dashboard && npm install
npm run dev
```

Docker dev images are provided as `api/Dockerfile.dev` and `dashboard/Dockerfile.dev`.

## CI

The `CI` workflow runs on every push and pull request to `main`:

1. **Dashboard** — `npm run lint` (ESLint) and `tsc --noEmit` (TypeScript).
2. **API** — `pylint` (errors only) and `pytest`.
3. **Docker** — builds both `api` and `dashboard` images via Buildx (no push).
