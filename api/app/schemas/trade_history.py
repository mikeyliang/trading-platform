from pydantic import BaseModel, Field, field_validator, ConfigDict
from typing import Optional, List, Dict, Any
from datetime import datetime


_ALLOWED_SIDES = {"BUY", "SELL"}
_ALLOWED_ORDER_TYPES = {"market", "limit", "stop", "stop_limit"}
_ALLOWED_STATUSES = {"PENDING", "FILLED", "PARTIALLY_FILLED", "CANCELLED", "REJECTED", "CLOSED"}


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
        if isinstance(v, str):
            v = v.strip().lower()
        if v not in _ALLOWED_ORDER_TYPES:
            raise ValueError(f"order_type must be one of {sorted(_ALLOWED_ORDER_TYPES)}")
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
    status: str = Field(..., description="Current trade status.")
    pnl: Optional[float] = Field(None, description="Realized P&L (USD), if closed.")
    pnl_percentage: Optional[float] = Field(None, description="Realized P&L percentage, if closed.")
    timestamp: datetime = Field(..., description="Execution timestamp.")
    created_at: datetime = Field(..., description="Row insert time.")
    updated_at: datetime = Field(..., description="Row last-update time.")

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
