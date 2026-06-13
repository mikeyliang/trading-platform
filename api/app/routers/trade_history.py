"""Trade-history CRUD endpoints.

Thin HTTP layer over ``trade_history_store``. The store is the single
source of truth for filtering, pagination, soft-delete, and stats math —
this module only validates payloads, maps store dicts onto Pydantic
response models, and translates miss / failure into the right HTTP code.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
from datetime import date, datetime, timedelta
from typing import Any, Iterable, List, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from ..config import settings
from ..schemas.trade_history import (
    TradeAnalysisResponse,
    TradeHistoryCreate,
    TradeHistoryImportError,
    TradeHistoryImportResult,
    TradeHistoryListResponse,
    TradeHistoryResponse,
    TradeHistoryUpdate,
    TradeStats,
)
from ..services import flex_jobs, ibkr_flex, trade_history_store

_EXPORT_COLUMNS = [
    "id", "timestamp", "symbol", "side", "quantity", "price",
    "order_type", "status", "pnl", "pnl_percentage", "strategy",
    "agent_id", "metadata",
]
_MAX_IMPORT_BYTES = 10 * 1024 * 1024  # 10 MiB

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/trade-history", tags=["trade-history"])


# "" alias: Next.js 308-normalizes trailing slashes away before proxying, and
# FastAPI's slash-redirect answers with an absolute docker-internal Location
# (http://trading-api:8000/...) the browser can't follow. Serving both paths
# directly avoids the redirect entirely.
@router.get("", response_model=TradeHistoryListResponse, include_in_schema=False)
@router.get(
    "/",
    response_model=TradeHistoryListResponse,
    summary="List trade-history rows with pagination and filters.",
)
async def list_trade_history(
    symbol: Optional[str] = Query(None, description="Filter by ticker (case-insensitive)."),
    status_: Optional[str] = Query(None, alias="status", description="Filter by trade status."),
    side: Optional[str] = Query(None, description="Filter by side (BUY / SELL)."),
    strategy: Optional[str] = Query(None, description="Filter by strategy tag."),
    agent_id: Optional[str] = Query(None, description="Filter by placing agent ID."),
    start: Optional[datetime] = Query(None, description="Inclusive lower bound on timestamp."),
    end: Optional[datetime] = Query(None, description="Inclusive upper bound on timestamp."),
    asset_class: Optional[str] = Query(
        None,
        description="High-level bucket on metadata.asset_category: 'option', 'stock', or 'future'.",
    ),
    account_id: Optional[str] = Query(
        None, description="Filter by metadata.account_id (e.g. U12765333).",
    ),
    transaction_type: Optional[str] = Query(
        None,
        description="Filter by metadata.transaction_type (e.g. EXPIRATION, EXERCISE, ASSIGNMENT, ExchTrade).",
    ),
    has_note: Optional[bool] = Query(
        None,
        description="true → only trades with a non-empty metadata.note. false → only without. null/absent → no filter.",
    ),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
) -> TradeHistoryListResponse:
    result = await trade_history_store.list_trades(
        symbol=symbol,
        status=status_,
        side=side,
        strategy=strategy,
        agent_id=agent_id,
        start=start,
        end=end,
        asset_class=asset_class,
        account_id=account_id,
        transaction_type=transaction_type,
        has_note=has_note,
        page=page,
        page_size=page_size,
    )
    return TradeHistoryListResponse(**result)


@router.get(
    "/stats",
    response_model=TradeStats,
    summary="Aggregate P&L stats across the filtered trade set.",
)
async def trade_history_stats(
    symbol: Optional[str] = Query(None),
    strategy: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
) -> TradeStats:
    result = await trade_history_store.get_trade_stats(
        symbol=symbol,
        strategy=strategy,
        agent_id=agent_id,
        start=start,
        end=end,
    )
    return TradeStats(**result)


@router.get(
    "/analysis",
    response_model=TradeAnalysisResponse,
    summary="Trade-history insights: highlights, hold time, top strategies, hour-of-day patterns.",
)
async def trade_history_analysis(
    symbol: Optional[str] = Query(None),
    strategy: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
) -> TradeAnalysisResponse:
    result = await trade_history_store.get_trade_analysis(
        symbol=symbol,
        strategy=strategy,
        agent_id=agent_id,
        start=start,
        end=end,
    )
    return TradeAnalysisResponse(**result)


@router.post(
    "/recompute-pnl",
    summary="Recompute FIFO realized P&L for every trade and write the pnl column.",
)
async def recompute_pnl() -> dict:
    """Backfilled trades carry no realized P&L (IBKR Flex doesn't provide it).
    This FIFO-matches closes against opens per contract and fills in pnl so
    the trades table, chart markers and stats show real gains/losses."""
    return await trade_history_store.recompute_realized_pnl()


# "" alias — same Next.js slash-normalization issue as the list route above.
@router.post("", response_model=TradeHistoryResponse, status_code=status.HTTP_201_CREATED, include_in_schema=False)
@router.post(
    "/",
    response_model=TradeHistoryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Insert a trade row.",
)
async def create_trade_history(payload: TradeHistoryCreate) -> TradeHistoryResponse:
    row = await trade_history_store.create_trade(payload.model_dump(by_alias=False))
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="trade_history insert unavailable",
        )
    return TradeHistoryResponse(**row)


@router.put(
    "/{trade_id}",
    response_model=TradeHistoryResponse,
    summary="Patch mutable fields on an existing trade.",
)
async def update_trade_history(trade_id: int, payload: TradeHistoryUpdate) -> TradeHistoryResponse:
    updates = payload.model_dump(by_alias=False, exclude_unset=True)
    row = await trade_history_store.update_trade(trade_id, updates)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"trade {trade_id} not found",
        )
    return TradeHistoryResponse(**row)


@router.post(
    "/import",
    response_model=TradeHistoryImportResult,
    summary="Bulk-import trades from a CSV or JSON file upload.",
)
async def import_trade_history(
    file: UploadFile = File(..., description="CSV or JSON file. JSON may be a list or {trades: [...]}."),
) -> TradeHistoryImportResult:
    raw = await file.read()
    if len(raw) > _MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"upload exceeds {_MAX_IMPORT_BYTES} bytes",
        )
    fmt = _detect_format(file.filename, file.content_type, raw)
    try:
        rows = _parse_csv(raw) if fmt == "csv" else _parse_json(raw)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    valid: list[dict[str, Any]] = []
    errors: list[TradeHistoryImportError] = []
    for i, row in enumerate(rows):
        try:
            model = TradeHistoryCreate.model_validate(row)
        except ValidationError as e:
            errors.append(TradeHistoryImportError(row=i, error=_short_error(e)))
            continue
        valid.append(model.model_dump(by_alias=False))

    inserted = await trade_history_store.bulk_insert_trades(valid) if valid else 0
    if valid and inserted == 0:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="trade_history bulk insert unavailable",
        )
    return TradeHistoryImportResult(total=len(rows), inserted=inserted, errors=errors)


@router.get(
    "/backfill-flex/status",
    summary="Flex backfill availability: configured? cooldown active? how many rows so far?",
)
async def backfill_flex_status() -> dict:
    """Cheap probe the UI can hit before showing a 'Backfill' button.
    Reports whether Flex is configured, any active cooldown, and the
    current row count / date span already sourced from Flex."""
    configured = bool(settings.ibkr_flex_token and settings.ibkr_flex_query_id)
    cd = ibkr_flex.cooldown_remaining_sec()
    summary = await trade_history_store.flex_summary()
    return {
        "configured": configured,
        "cooldown_sec": int(cd),
        "query_id": settings.ibkr_flex_query_id or None,
        **summary,
    }


@router.post(
    "/backfill-flex",
    summary="Backfill trade history from IBKR Flex Web Service.",
)
async def backfill_flex(
    from_date: Optional[str] = Query(
        None,
        description="Override Flex query start date (yyyymmdd). Omit to use the Flex query's saved period.",
        pattern=r"^\d{8}$",
    ),
    to_date: Optional[str] = Query(
        None,
        description="Override Flex query end date (yyyymmdd). Activity Flex caps any single pull at 365 days.",
        pattern=r"^\d{8}$",
    ),
    years_back: int = Query(
        1,
        ge=1,
        le=10,
        description=(
            "Walk back this many 365-day slices from today. 1 = single pull "
            "(uses from/to overrides if given, else the Flex query's saved "
            "period). >1 ignores from/to and sweeps N consecutive slices."
        ),
    ),
    include_eae: bool = Query(
        True,
        description="Include option exercises / assignments / expirations as synthetic trade rows.",
    ),
    refresh: bool = Query(
        False,
        description=(
            "If true, overwrite existing rows on (source, external_id) conflict "
            "instead of skipping them. Refreshes timestamp / price / pnl / metadata "
            "from the latest Flex response — useful after parser changes."
        ),
    ),
    background: bool = Query(
        False,
        description=(
            "Run the sweep as a background task and return a job id immediately. "
            "Poll /backfill-flex/jobs/{id} for progress. Recommended for "
            "years_back > 1 so the browser doesn't hold a long HTTP connection."
        ),
    ),
) -> dict:
    """Pulls the configured Activity Flex Query, parses trades + EAE rows,
    and bulk-inserts via the (source, external_id) dedup index so repeat
    pulls are idempotent.

    For multi-year history pass ``years_back=N`` — the endpoint will issue
    N consecutive Flex requests (each capped at 365d, IBKR's hard limit),
    waiting briefly between calls so we don't trip Flex's rate limiter.
    Dedup by ibExecID means overlapping slices are safe.
    """
    if not settings.ibkr_flex_token or not settings.ibkr_flex_query_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID not configured",
        )

    # Short-circuit if the token is already in cooldown from a prior 1025
    # lockout — saves a wasted HTTP roundtrip and avoids spawning a
    # doomed background task.
    cd = ibkr_flex.cooldown_remaining_sec()
    if cd > 0:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"IBKR Flex token in cooldown — retry in ~{cd:.0f}s",
            headers={"Retry-After": str(int(cd) + 1)},
        )

    if years_back == 1:
        slices: List[tuple[Optional[str], Optional[str]]] = [(from_date, to_date)]
    else:
        slices = _year_slices(years_back)

    if background:
        job = flex_jobs.create_job(
            slice_count=len(slices),
            refresh=refresh,
            years_back=years_back,
        )

        async def _worker() -> None:
            try:
                result = await _run_flex_sweep(
                    slices, include_eae=include_eae, refresh=refresh, job=job,
                )
                flex_jobs.mark_done(job, result)
            except Exception as e:  # noqa: BLE001
                logger.exception("flex background job %s failed", job.id)
                flex_jobs.mark_failed(job, str(e))

        task = asyncio.create_task(_worker(), name=f"flex-job-{job.id}")
        flex_jobs.attach_task(job, task)
        return {
            "job_id": job.id,
            "status": "running",
            "slice_count": len(slices),
            "years_back": years_back,
            "refresh": refresh,
        }

    return await _run_flex_sweep(slices, include_eae=include_eae, refresh=refresh)


async def _run_flex_sweep(
    slices: List[tuple[Optional[str], Optional[str]]],
    *,
    include_eae: bool,
    refresh: bool,
    job: Optional[flex_jobs.FlexJob] = None,
) -> Dict[str, Any]:
    """Execute the slice-by-slice Flex sweep. Shared between foreground
    and background paths. When ``job`` is provided, progress is mirrored
    into the job so a polling client can render slice X / Y."""
    all_trades: list[dict[str, Any]] = []
    all_eae: list[dict[str, Any]] = []
    accounts: set[str] = set()
    slice_log: list[dict[str, Any]] = []

    consec_unavailable = 0
    for i, (fd, td) in enumerate(slices):
        if i > 0:
            await asyncio.sleep(settings.ibkr_flex_slice_delay_sec)
        if job is not None:
            # Report 1-indexed so "slice 1/5" reads naturally in the UI.
            job.report_progress(current_slice=i + 1)
        try:
            result = await ibkr_flex.pull_trades(
                settings.ibkr_flex_token,
                settings.ibkr_flex_query_id,
                from_date=fd,
                to_date=td,
            )
        except ibkr_flex.FlexCooldownError as e:
            # Lockout fired mid-sweep — abort the rest, return what we
            # have, surface Retry-After so callers can back off.
            info = {
                "from": fd, "to": td,
                "error": str(e),
                "info": "cooldown engaged — aborting remaining slices",
            }
            slice_log.append(info)
            if job is not None:
                job.report_progress(current_slice=i + 1, slice_info=info)
            break
        except ibkr_flex.FlexError as e:
            logger.warning("flex slice %s..%s failed: %s", fd, td, e)
            info = {"from": fd, "to": td, "error": str(e), "code": e.code}
            slice_log.append(info)
            if job is not None:
                job.report_progress(current_slice=i + 1, slice_info=info)
            if e.code == "1003":
                consec_unavailable += 1
                if consec_unavailable >= 2 and i >= 1:
                    note = {"info": "retention exhausted — stopping sweep"}
                    slice_log.append(note)
                    if job is not None:
                        job.last_slice_info = note
                    break
            continue
        consec_unavailable = 0
        all_trades.extend(result.trades)
        if include_eae:
            all_eae.extend(result.option_eae)
        for a in result.accounts:
            accounts.add(a)
        info = {
            "from": fd, "to": td,
            "trades": len(result.trades),
            "option_eae": len(result.option_eae),
        }
        slice_log.append(info)
        if job is not None:
            job.report_progress(current_slice=i + 1, slice_info=info)

    payloads = all_trades + all_eae
    if refresh:
        counts = await trade_history_store.bulk_upsert_external_trades(payloads)
    else:
        counts = await trade_history_store.bulk_insert_external_trades(payloads)
        counts = {**counts, "updated": 0}
    return {
        "fetched": len(payloads),
        "trades": len(all_trades),
        "option_eae": len(all_eae),
        "accounts": sorted(accounts),
        "inserted": counts["inserted"],
        "updated": counts.get("updated", 0),
        "skipped": counts["skipped"],
        "refresh": refresh,
        "slices": slice_log,
    }


@router.get(
    "/backfill-flex/jobs",
    summary="List recent Flex backfill jobs (most recent first).",
)
async def list_flex_jobs(limit: int = Query(10, ge=1, le=50)) -> dict:
    return {"jobs": flex_jobs.list_jobs(limit=limit)}


@router.get(
    "/backfill-flex/jobs/{job_id}",
    summary="Status / result of a single Flex backfill job.",
)
async def get_flex_job(job_id: str) -> dict:
    job = flex_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"job {job_id} not found (process restart may have wiped it)",
        )
    return job.to_public()


def _year_slices(years_back: int) -> List[tuple[Optional[str], Optional[str]]]:
    """N consecutive 365-day windows walking backwards from yesterday.

    IBKR Flex refuses to build a report with ``to_date == today`` (returns
    code 1003 "Statement is not available") — the most recent end date
    that works is yesterday. Windows are returned newest-first so the
    most recent slice lands first even if older slices fail.
    """
    end = date.today() - timedelta(days=1)
    out: list[tuple[Optional[str], Optional[str]]] = []
    for i in range(years_back):
        td = end - timedelta(days=365 * i)
        fd = end - timedelta(days=365 * (i + 1) - 1)  # -1 so windows abut
        out.append((fd.strftime("%Y%m%d"), td.strftime("%Y%m%d")))
    return out


@router.get(
    "/export",
    summary="Download filtered trades as CSV.",
    response_class=StreamingResponse,
)
async def export_trade_history(
    symbol: Optional[str] = Query(None),
    status_: Optional[str] = Query(None, alias="status"),
    side: Optional[str] = Query(None),
    strategy: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    asset_class: Optional[str] = Query(None),
    account_id: Optional[str] = Query(None),
    transaction_type: Optional[str] = Query(None),
) -> StreamingResponse:
    rows = await trade_history_store.export_trades(
        symbol=symbol,
        status=status_,
        side=side,
        strategy=strategy,
        agent_id=agent_id,
        start=start,
        end=end,
        asset_class=asset_class,
        account_id=account_id,
        transaction_type=transaction_type,
    )
    stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    filename = f"trade_history_{stamp}.csv"
    return StreamingResponse(
        _csv_stream(rows),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete(
    "/{trade_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Soft-delete a trade row (flips is_deleted).",
)
async def delete_trade_history(trade_id: int) -> None:
    deleted = await trade_history_store.delete_trade(trade_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"trade {trade_id} not found or already deleted",
        )
    return None


def _detect_format(filename: Optional[str], content_type: Optional[str], raw: bytes) -> str:
    name = (filename or "").lower()
    ct = (content_type or "").lower()
    if name.endswith(".json") or "json" in ct:
        return "json"
    if name.endswith(".csv") or "csv" in ct:
        return "csv"
    # Fallback: sniff the first non-whitespace byte.
    head = raw.lstrip()[:1]
    if head in (b"[", b"{"):
        return "json"
    if head:
        return "csv"
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="unsupported file type; expected .csv or .json",
    )


def _parse_json(raw: bytes) -> list[dict[str, Any]]:
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ValueError(f"invalid JSON: {e}") from e
    if isinstance(data, dict) and "trades" in data:
        data = data["trades"]
    if not isinstance(data, list):
        raise ValueError("JSON must be a list of trades or an object with a 'trades' array")
    out: list[dict[str, Any]] = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError(f"row {i}: expected object, got {type(item).__name__}")
        out.append(item)
    return out


def _parse_csv(raw: bytes) -> list[dict[str, Any]]:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise ValueError(f"invalid UTF-8 in CSV: {e}") from e
    reader = csv.DictReader(io.StringIO(text))
    out: list[dict[str, Any]] = []
    for row in reader:
        out.append(_coerce_csv_row(row))
    return out


def _coerce_csv_row(row: dict[str, Any]) -> dict[str, Any]:
    """Strip blanks and JSON-decode the metadata column so Pydantic gets
    a clean payload it can coerce."""
    cleaned: dict[str, Any] = {}
    for k, v in row.items():
        if k is None or v is None or v == "":
            continue
        key = k.strip()
        if key in ("metadata", "metadata_"):
            try:
                cleaned[key] = json.loads(v)
            except (TypeError, ValueError):
                # Leave as string; Pydantic will reject it cleanly.
                cleaned[key] = v
        else:
            cleaned[key] = v
    return cleaned


def _short_error(e: ValidationError) -> str:
    parts = []
    for err in e.errors():
        loc = ".".join(str(x) for x in err.get("loc", ())) or "<root>"
        parts.append(f"{loc}: {err.get('msg', 'invalid')}")
    return "; ".join(parts)


def _csv_stream(rows: Iterable[dict[str, Any]]) -> Iterable[str]:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_EXPORT_COLUMNS)
    yield buf.getvalue()
    for row in rows:
        meta = row.get("metadata_") if "metadata_" in row else row.get("metadata")
        out = [
            row.get("id", ""),
            row.get("timestamp", ""),
            row.get("symbol", ""),
            row.get("side", ""),
            row.get("quantity", ""),
            row.get("price", ""),
            row.get("order_type", ""),
            row.get("status", ""),
            row.get("pnl", "") if row.get("pnl") is not None else "",
            row.get("pnl_percentage", "") if row.get("pnl_percentage") is not None else "",
            row.get("strategy", "") or "",
            row.get("agent_id", "") or "",
            json.dumps(meta) if meta is not None else "",
        ]
        buf.seek(0)
        buf.truncate(0)
        writer.writerow(out)
        yield buf.getvalue()
