"""Trade-history CRUD endpoints.

Thin HTTP layer over ``trade_history_store``. The store is the single
source of truth for filtering, pagination, soft-delete, and stats math —
this module only validates payloads, maps store dicts onto Pydantic
response models, and translates miss / failure into the right HTTP code.
"""
from __future__ import annotations

import csv
import io
import json
import logging
from datetime import datetime
from typing import Any, Iterable, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

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
from ..services import ib_trade_log, trade_history_store

_EXPORT_COLUMNS = [
    "id", "timestamp", "symbol", "side", "quantity", "price",
    "order_type", "status", "pnl", "pnl_percentage", "strategy",
    "agent_id", "metadata",
]
_MAX_IMPORT_BYTES = 10 * 1024 * 1024  # 10 MiB

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/trade-history", tags=["trade-history"])


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
    "/sync-ibkr",
    summary="Pull today's fills from IBKR and log the new ones.",
)
async def sync_ibkr_trades() -> dict:
    """Fetch current-session executions from the IBKR gateway, dedupe on
    execution id, and persist the new fills. Returns
    ``{fetched, inserted, skipped, error}``. Also wired to a scheduler job
    every 10 minutes during RTH, so the manual button is just "sync now"."""
    return await ib_trade_log.sync_executions()


@router.get(
    "/markers/{symbol}",
    summary="Trades on a symbol shaped for chart markers.",
)
async def trade_markers(
    symbol: str,
    days: int = Query(90, ge=1, le=365, description="Trailing window."),
) -> dict:
    trades = await trade_history_store.trades_for_markers(symbol, days=days)
    return {"symbol": symbol.upper(), "trades": trades}


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
) -> StreamingResponse:
    rows = await trade_history_store.export_trades(
        symbol=symbol,
        status=status_,
        side=side,
        strategy=strategy,
        agent_id=agent_id,
        start=start,
        end=end,
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
