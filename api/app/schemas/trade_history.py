from pydantic import BaseModel, Field, field_validator, ConfigDict
from typing import Optional, List, Dict, Any
from datetime import datetime


_ALLOWED_SIDES = {"BUY", "SELL"}
_ALLOWED_STATUSES = {"PENDING", "FILLED", "PARTIALLY_FILLED", "CANCELLED", "REJECTED", "CLOSED"}

# IBKR / Flex emit short codes for order types. Translate the ones we know
# back to our canonical lowercase form so they round-trip cleanly. Unknown
# strings are accepted as-is — the column is free-form in the DB and we'd
# rather surface the raw IBKR label than reject an entire response payload.
_ORDER_TYPE_ALIASES = {
    "lmt": "limit",
    "mkt": "market",
    "stp": "stop",
    "stp_limit": "stop_limit",
    "stp lmt": "stop_limit",
}


class TradeHistoryBase(BaseModel):
    symbol: str = Field(
        ...,
        min_length=1,
        max_length=12,
        pattern=r"^[A-Z0-9\.\-]+$",
        description="Uppercase ticker (1-12 chars). Only A-Z, 0-9, '.' and '-'.",
    )
    side: str = Field(..., description="BUY or SELL.")
    quantity: float = Field(..., gt=0, le=1_000_000, description="Trade quantity (shares/contracts).")
    price: float = Field(..., gt=0, le=1_000_000, description="Execution price per unit.")
    order_type: str = Field(
        "market",
        description="Brokerage order type: market | limit | stop | stop_limit.",
    )
    strategy: Optional[str] = Field(None, max_length=64, description="Strategy tag for attribution.")
    agent_id: Optional[str] = Field(None, max_length=64, description="ID of the agent that placed the trade.")
    metadata_: Optional[Dict[str, Any]] = Field(
        None,
        alias="metadata",
        description="Free-form metadata blob (entry signal, indicators, notes).",
    )

    @field_validator("symbol", mode="before")
    @classmethod
    def _norm_symbol(cls, v: Any) -> Any:
        return v.strip().upper() if isinstance(v, str) else v

    @field_validator("side", mode="before")
    @classmethod
    def _norm_side(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip().upper()
        if v not in _ALLOWED_SIDES:
            raise ValueError(f"side must be one of {sorted(_ALLOWED_SIDES)}")
        return v

    @field_validator("order_type", mode="before")
    @classmethod
    def _norm_order_type(cls, v: Any) -> Any:
        if not isinstance(v, str):
            return v
        s = v.strip().lower()
        return _ORDER_TYPE_ALIASES.get(s, s) or "market"

    model_config = ConfigDict(
        populate_by_name=True,
        json_schema_extra={
            "example": {
                "symbol": "SPY",
                "side": "BUY",
                "quantity": 10,
                "price": 458.12,
                "order_type": "limit",
                "strategy": "bull-put-spy",
                "agent_id": "agent_smi_01",
                "metadata": {"signal": "smi_cross_up", "rsi": 42.1},
            }
        },
    )


class TradeHistoryCreate(TradeHistoryBase):
    status: str = Field("FILLED", description="Trade status at create time.")
    timestamp: Optional[datetime] = Field(
        None, description="Execution timestamp; defaults to server time when omitted.",
    )

    @field_validator("status", mode="before")
    @classmethod
    def _norm_status(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip().upper()
        if v not in _ALLOWED_STATUSES:
            raise ValueError(f"status must be one of {sorted(_ALLOWED_STATUSES)}")
        return v

    model_config = ConfigDict(
        populate_by_name=True,
        json_schema_extra={
            "example": {
                "symbol": "SPY",
                "side": "BUY",
                "quantity": 10,
                "price": 458.12,
                "order_type": "limit",
                "strategy": "bull-put-spy",
                "agent_id": "agent_smi_01",
                "status": "FILLED",
                "timestamp": "2026-05-23T14:32:11Z",
                "metadata": {"signal": "smi_cross_up"},
            }
        },
    )


class TradeHistoryUpdate(BaseModel):
    pnl: Optional[float] = Field(None, ge=-1_000_000_000, le=1_000_000_000, description="Realized P&L (USD).")
    pnl_percentage: Optional[float] = Field(
        None, ge=-100_000.0, le=100_000.0, description="Realized P&L as a percentage.",
    )
    status: Optional[str] = Field(None, description="Updated trade status.")
    metadata_: Optional[Dict[str, Any]] = Field(
        None,
        alias="metadata",
        description="Replacement metadata blob.",
    )

    @field_validator("status", mode="before")
    @classmethod
    def _norm_status(cls, v: Any) -> Any:
        if v is None:
            return v
        if isinstance(v, str):
            v = v.strip().upper()
        if v not in _ALLOWED_STATUSES:
            raise ValueError(f"status must be one of {sorted(_ALLOWED_STATUSES)}")
        return v

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
        json_schema_extra={
            "example": {
                "pnl": 42.50,
                "pnl_percentage": 0.93,
                "status": "CLOSED",
                "metadata": {"exit_reason": "profit_target"},
            }
        },
    )


class TradeHistoryResponse(TradeHistoryBase):
    id: int = Field(..., description="Database row ID.")
    # Historical rows legitimately include price-0 fills: option EXPIRATION /
    # ASSIGNMENT / BookTrade events (and rare qty-0 corporate actions). The
    # create-input constraints on TradeHistoryBase are deliberately strict
    # (gt=0), but the *response* must reflect whatever is in the DB or the
    # whole list payload 500s. Relax to ge=0 here.
    quantity: float = Field(..., ge=0, le=1_000_000, description="Trade quantity (shares/contracts).")
    price: float = Field(..., ge=0, le=1_000_000, description="Execution price per unit.")
    status: str = Field(..., description="Current trade status.")
    pnl: Optional[float] = Field(None, description="Realized P&L (USD), if closed.")
    pnl_percentage: Optional[float] = Field(None, description="Realized P&L percentage, if closed.")
    timestamp: datetime = Field(..., description="Execution timestamp.")
    # created_at / updated_at aren't materialized in the trade_history
    # schema today — they're optional on response so legacy rows (and
    # Flex-imported rows) don't fail validation. Will become required
    # if/when the columns are added.
    created_at: Optional[datetime] = Field(None, description="Row insert time, if tracked.")
    updated_at: Optional[datetime] = Field(None, description="Row last-update time, if tracked.")

    model_config = ConfigDict(
        populate_by_name=True,
        json_schema_extra={
            "example": {
                "id": 12345,
                "symbol": "SPY",
                "side": "BUY",
                "quantity": 10,
                "price": 458.12,
                "order_type": "limit",
                "strategy": "bull-put-spy",
                "agent_id": "agent_smi_01",
                "status": "FILLED",
                "pnl": 42.50,
                "pnl_percentage": 0.93,
                "timestamp": "2026-05-23T14:32:11Z",
                "created_at": "2026-05-23T14:32:11Z",
                "updated_at": "2026-05-23T14:32:11Z",
                "metadata": {"signal": "smi_cross_up"},
            }
        },
    )


class TradeStats(BaseModel):
    total_trades: int = Field(0, ge=0)
    winning_trades: int = Field(0, ge=0)
    losing_trades: int = Field(0, ge=0)
    win_rate: float = Field(0.0, ge=0.0, le=1.0, description="winning_trades / total_trades.")
    total_pnl: float = Field(0.0, description="Sum of realized P&L across all closed trades.")
    avg_pnl: float = Field(0.0, description="Mean realized P&L per closed trade.")
    profit_factor: float = Field(
        0.0, ge=0.0,
        description="Gross profit divided by gross loss; 0 when there are no losses.",
    )

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "total_trades": 24,
            "winning_trades": 15,
            "losing_trades": 9,
            "win_rate": 0.625,
            "total_pnl": 1_240.55,
            "avg_pnl": 51.69,
            "profit_factor": 2.31,
        }
    })


class TradeAnalysisTrade(BaseModel):
    """Compact snapshot of a single trade highlighted by the analysis endpoint."""
    id: int = Field(..., description="Database row ID.")
    symbol: Optional[str] = Field(None, description="Ticker.")
    side: Optional[str] = Field(None, description="BUY or SELL.")
    quantity: Optional[float] = Field(None, description="Trade quantity.")
    price: Optional[float] = Field(None, description="Execution price per unit.")
    pnl: Optional[float] = Field(None, description="Realized P&L (USD).")
    pnl_percentage: Optional[float] = Field(None, description="Realized P&L percentage.")
    timestamp: datetime = Field(..., description="Execution timestamp.")
    strategy: Optional[str] = Field(None, description="Strategy tag.")


class StrategyInsight(BaseModel):
    strategy: str = Field(..., description="Strategy tag.")
    count: int = Field(..., ge=0, description="Number of trades using this strategy.")
    total_pnl: float = Field(..., description="Sum of realized P&L for this strategy.")
    win_rate: float = Field(..., ge=0.0, le=1.0, description="Winning closed trades / closed trades for this strategy.")


class TimeOfDayInsight(BaseModel):
    hour: int = Field(..., ge=0, le=23, description="Hour of day in UTC (0-23).")
    count: int = Field(..., ge=0, description="Number of trades executed during this hour.")
    total_pnl: float = Field(..., description="Sum of realized P&L for this hour.")
    avg_pnl: float = Field(..., description="Mean realized P&L per closed trade in this hour.")
    win_rate: float = Field(..., ge=0.0, le=1.0, description="Winning closed trades / closed trades for this hour.")


class TradeAnalysisResponse(BaseModel):
    best_trade: Optional[TradeAnalysisTrade] = Field(
        None, description="Trade with the highest pnl_percentage.",
    )
    worst_trade: Optional[TradeAnalysisTrade] = Field(
        None, description="Trade with the lowest pnl_percentage.",
    )
    biggest_win: Optional[TradeAnalysisTrade] = Field(
        None, description="Trade with the largest positive pnl (USD).",
    )
    biggest_loss: Optional[TradeAnalysisTrade] = Field(
        None, description="Trade with the largest negative pnl (USD).",
    )
    avg_hold_time_seconds: Optional[float] = Field(
        None,
        description="Average BUY→SELL holding period in seconds; null when no paired trades exist.",
    )
    common_strategies: List[StrategyInsight] = Field(
        default_factory=list,
        description="Top strategies by trade count (up to 10).",
    )
    time_of_day_patterns: List[TimeOfDayInsight] = Field(
        default_factory=list,
        description="Per-hour-of-day breakdown (UTC).",
    )

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "best_trade": {
                "id": 9001, "symbol": "SPY", "side": "SELL", "quantity": 10, "price": 470.0,
                "pnl": 119.0, "pnl_percentage": 2.6, "timestamp": "2026-05-23T14:32:11Z",
                "strategy": "bull-put-spy",
            },
            "worst_trade": {
                "id": 9020, "symbol": "TSLA", "side": "SELL", "quantity": 5, "price": 170.0,
                "pnl": -82.5, "pnl_percentage": -4.7, "timestamp": "2026-05-21T18:02:00Z",
                "strategy": "mean-reversion",
            },
            "biggest_win": {
                "id": 9001, "symbol": "SPY", "side": "SELL", "quantity": 10, "price": 470.0,
                "pnl": 119.0, "pnl_percentage": 2.6, "timestamp": "2026-05-23T14:32:11Z",
                "strategy": "bull-put-spy",
            },
            "biggest_loss": {
                "id": 9020, "symbol": "TSLA", "side": "SELL", "quantity": 5, "price": 170.0,
                "pnl": -82.5, "pnl_percentage": -4.7, "timestamp": "2026-05-21T18:02:00Z",
                "strategy": "mean-reversion",
            },
            "avg_hold_time_seconds": 3725.4,
            "common_strategies": [
                {"strategy": "bull-put-spy", "count": 12, "total_pnl": 540.25, "win_rate": 0.75},
            ],
            "time_of_day_patterns": [
                {"hour": 14, "count": 8, "total_pnl": 220.0, "avg_pnl": 27.5, "win_rate": 0.625},
            ],
        }
    })


class TradeHistoryImportError(BaseModel):
    row: int = Field(..., ge=0, description="0-based row index in the uploaded file.")
    error: str = Field(..., description="Validation / parse error for this row.")


class TradeHistoryImportResult(BaseModel):
    total: int = Field(0, ge=0, description="Rows parsed from the upload.")
    inserted: int = Field(0, ge=0, description="Rows persisted to trade_history.")
    errors: List[TradeHistoryImportError] = Field(
        default_factory=list,
        description="Per-row validation errors; rejected rows are skipped, valid rows still commit.",
    )

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "total": 3,
            "inserted": 2,
            "errors": [{"row": 1, "error": "side must be one of ['BUY', 'SELL']"}],
        }
    })


class TradeHistoryListResponse(BaseModel):
    trades: List[TradeHistoryResponse] = Field(default_factory=list)
    total: int = Field(0, ge=0, description="Total matching rows across all pages.")
    page: int = Field(1, ge=1)
    page_size: int = Field(50, ge=1, le=500)
    total_pages: int = Field(0, ge=0)

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "trades": [
                {
                    "id": 12345,
                    "symbol": "SPY",
                    "side": "BUY",
                    "quantity": 10,
                    "price": 458.12,
                    "order_type": "limit",
                    "strategy": "bull-put-spy",
                    "agent_id": "agent_smi_01",
                    "status": "FILLED",
                    "pnl": 42.50,
                    "pnl_percentage": 0.93,
                    "timestamp": "2026-05-23T14:32:11Z",
                    "created_at": "2026-05-23T14:32:11Z",
                    "updated_at": "2026-05-23T14:32:11Z",
                    "metadata": {"signal": "smi_cross_up"},
                }
            ],
            "total": 1,
            "page": 1,
            "page_size": 50,
            "total_pages": 1,
        }
    })
