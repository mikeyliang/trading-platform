# Trading Platform

[![CI](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml)
[![Dashboard](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml/badge.svg?event=push&job=dashboard)](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml)
[![API](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml/badge.svg?event=push&job=api)](https://github.com/mikeyliang/trading-platform/actions/workflows/ci.yml)

A trading platform with a FastAPI backend (`api/`) and a Next.js dashboard (`dashboard/`).

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
