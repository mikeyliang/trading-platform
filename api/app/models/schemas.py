from pydantic import BaseModel, Field, field_validator, model_validator, ConfigDict
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime
from enum import Enum


class OrderSide(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class OrderStatus(str, Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"


class StrategyStatus(str, Enum):
    RUNNING = "running"
    STOPPED = "stopped"
    ERROR = "error"


class Timeframe(str, Enum):
    M1 = "1m"
    M5 = "5m"
    M15 = "15m"
    M30 = "30m"
    H1 = "1h"
    H4 = "4h"
    D1 = "1d"


# Reusable Field constraints
SymbolField = Field(
    ...,
    min_length=1,
    max_length=12,
    pattern=r"^[A-Z0-9\.\-]+$",
    description="Uppercase ticker (1-12 chars). Only A-Z, 0-9, '.' and '-'.",
)


class BarData(BaseModel):
    time: int  # unix timestamp (seconds)
    open: float
    high: float
    low: float
    close: float
    volume: float


class Quote(BaseModel):
    symbol: str
    bid: float
    ask: float
    last: float
    volume: float
    change: float
    change_pct: float
    timestamp: datetime


class Position(BaseModel):
    symbol: str                       # underlying ticker (e.g. "USO")
    quantity: float
    avg_price: float
    current_price: float
    unrealized_pnl: float
    unrealized_pnl_pct: float
    side: OrderSide
    sector: Optional[str] = None
    # Option-only metadata. ``is_option`` flips the UI into options mode
    # so the row can show "Jan 15 '27 · 80P" beneath the underlying.
    is_option: bool = False
    strike: Optional[float] = None
    expiry: Optional[str] = None       # YYYYMMDD
    right: Optional[str] = None        # "C" or "P"
    multiplier: Optional[float] = None # 100 for standard options

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "symbol": "AAPL",
            "quantity": 100,
            "avg_price": 178.20,
            "current_price": 182.50,
            "unrealized_pnl": 430.0,
            "unrealized_pnl_pct": 2.41,
            "side": "BUY",
            "sector": "Technology",
            "is_option": False,
        }
    })


class Order(BaseModel):
    id: str
    symbol: str
    side: OrderSide
    quantity: float
    price: Optional[float] = None
    status: OrderStatus
    filled_qty: float = 0.0
    avg_fill_price: Optional[float] = None
    timestamp: datetime
    strategy: Optional[str] = None

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "id": "ord_9f8e7d6c",
            "symbol": "SPY",
            "side": "BUY",
            "quantity": 10,
            "price": 458.00,
            "status": "FILLED",
            "filled_qty": 10,
            "avg_fill_price": 458.12,
            "timestamp": "2026-05-23T14:31:55Z",
            "strategy": "bull-put-spy",
        }
    })


class CreateOrderRequest(BaseModel):
    """Validated request payload for placing a brokerage order.

    Order placement is not yet exposed (see ``routers/orders.py`` docstring)
    — this model defines the validated request shape for when the endpoint
    is added behind explicit user confirmation."""

    symbol: str = Field(
        ...,
        min_length=1,
        max_length=12,
        pattern=r"^[A-Z0-9\.\-]+$",
        description="Uppercase ticker (1-12 chars). Only A-Z, 0-9, '.' and '-'.",
    )
    side: OrderSide = Field(..., description="BUY or SELL.")
    quantity: float = Field(..., gt=0, le=1_000_000, description="Order quantity (shares/contracts).")
    order_type: Literal["market", "limit", "stop", "stop_limit"] = Field(
        "market", description="Brokerage order type.",
    )
    limit_price: Optional[float] = Field(
        None, gt=0, le=1_000_000,
        description="Required when order_type is 'limit' or 'stop_limit'.",
    )
    stop_price: Optional[float] = Field(
        None, gt=0, le=1_000_000,
        description="Required when order_type is 'stop' or 'stop_limit'.",
    )
    tif: Literal["day", "gtc", "ioc", "fok"] = Field(
        "day", description="Time-in-force.",
    )
    strategy: Optional[str] = Field(
        None, max_length=64,
        description="Optional strategy tag for attribution.",
    )

    @field_validator("symbol", mode="before")
    @classmethod
    def _norm_symbol(cls, v: Any) -> Any:
        return v.strip().upper() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _check_prices(self) -> "CreateOrderRequest":
        needs_limit = self.order_type in ("limit", "stop_limit")
        needs_stop = self.order_type in ("stop", "stop_limit")
        if needs_limit and self.limit_price is None:
            raise ValueError(f"limit_price is required when order_type is '{self.order_type}'")
        if needs_stop and self.stop_price is None:
            raise ValueError(f"stop_price is required when order_type is '{self.order_type}'")
        if not needs_limit and self.limit_price is not None:
            raise ValueError(f"limit_price must be omitted when order_type is '{self.order_type}'")
        if not needs_stop and self.stop_price is not None:
            raise ValueError(f"stop_price must be omitted when order_type is '{self.order_type}'")
        return self

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "example": {
                "symbol": "SPY",
                "side": "BUY",
                "quantity": 10,
                "order_type": "limit",
                "limit_price": 458.00,
                "tif": "day",
                "strategy": "bull-put-spy",
            }
        },
    )


class Trade(BaseModel):
    id: str
    symbol: str
    side: OrderSide
    quantity: float
    price: float
    pnl: Optional[float] = None
    timestamp: datetime
    strategy: Optional[str] = None

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "id": "a1b2c3d4",
            "symbol": "SPY",
            "side": "BUY",
            "quantity": 10,
            "price": 458.12,
            "pnl": 42.50,
            "timestamp": "2026-05-23T14:32:11Z",
            "strategy": "bull-put-spy",
        }
    })


class AccountSummary(BaseModel):
    """IBKR account snapshot. When the gateway is disconnected, fields are
    zeroed and ``mode`` falls back to the configured trading mode."""

    balance: float = Field(0.0, description="Total cash value (USD).")
    equity: float = Field(0.0, description="Net liquidation (cash + position market value).")
    buying_power: float = Field(0.0, description="Available buying power for new positions.")
    unrealized_pnl: float = Field(0.0, description="Sum of open-position unrealized P&L.")
    realized_pnl: float = Field(0.0, description="Realized P&L for the session.")
    total_trades: int = 0
    win_rate: float = 0.0
    mode: str = Field("paper", description="paper | live")
    locked: Optional[float] = Field(None, description="Margin held by open positions.")
    currency: Optional[str] = "USD"
    account_id: Optional[str] = None

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "balance": 50_000.0,
            "equity": 102_345.21,
            "buying_power": 250_000.0,
            "unrealized_pnl": 1_245.10,
            "realized_pnl": 320.00,
            "total_trades": 8,
            "win_rate": 0.625,
            "mode": "paper",
            "locked": 8_500.0,
            "currency": "USD",
            "account_id": "DU1234567",
        }
    })


class WatchlistItem(BaseModel):
    symbol: str
    sector: str
    name: str
    last: Optional[float] = None
    change: Optional[float] = None        # absolute $ change vs. previous close
    change_pct: Optional[float] = None
    volume: Optional[float] = None

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "symbol": "AAPL",
            "sector": "Technology",
            "name": "Apple Inc.",
            "last": 182.50,
            "change_pct": 1.31,
            "volume": 42_103_400,
        }
    })


class WatchlistAddRequest(BaseModel):
    symbol: str = Field(
        ...,
        min_length=1,
        max_length=12,
        description="Uppercase ticker (1-12 chars). Lowercase is normalized server-side.",
    )
    sector: Optional[str] = Field(
        default="Unknown", max_length=64, description="Sector label (free-form).",
    )
    name: Optional[str] = Field(
        default=None, max_length=128, description="Display name (free-form).",
    )

    @field_validator("symbol")
    @classmethod
    def _normalize_symbol(cls, v: str) -> str:
        v = v.strip().upper()
        if not v or any(c.isspace() for c in v):
            raise ValueError("symbol must be a non-empty whitespace-free ticker")
        return v

    model_config = ConfigDict(json_schema_extra={
        "example": {"symbol": "NVDA", "sector": "Technology", "name": "NVIDIA Corp."}
    })


class WatchlistDeleteResponse(BaseModel):
    removed: str = Field(..., description="Symbol that was removed from the watchlist.")

    model_config = ConfigDict(json_schema_extra={"example": {"removed": "NVDA"}})


class StrategyInfo(BaseModel):
    id: str
    name: str
    description: str
    status: StrategyStatus
    symbols: List[str]
    timeframe: str
    pnl: float = 0.0
    trades: int = 0
    win_rate: float = 0.0
    params: Dict[str, Any] = {}

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "id": "smi-mid",
            "name": "SMI Mid-Term Reversal",
            "description": "Stochastic Momentum Index crossover on 15m bars.",
            "status": "running",
            "symbols": ["SPY", "QQQ"],
            "timeframe": "15m",
            "pnl": 1240.55,
            "trades": 12,
            "win_rate": 0.58,
            "params": {"smi_period": 14, "smooth1": 25, "smooth2": 2, "signal": 9},
        }
    })


class StrategyStartRequest(BaseModel):
    symbols: List[str] = Field(..., min_length=1, max_length=50)
    timeframe: Timeframe = Timeframe.M15
    params: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("symbols")
    @classmethod
    def _normalize_symbols(cls, syms: List[str]) -> List[str]:
        out: List[str] = []
        seen = set()
        for s in syms:
            s = (s or "").strip().upper()
            if not s:
                raise ValueError("symbol entries cannot be empty")
            if any(c.isspace() for c in s):
                raise ValueError(f"symbol '{s}' contains whitespace")
            if s in seen:
                continue
            seen.add(s)
            out.append(s)
        if not out:
            raise ValueError("symbols list cannot be empty after normalization")
        return out

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "symbols": ["SPY", "QQQ"],
            "timeframe": "15m",
            "params": {"smi_period": 14},
        }
    })


class BacktestRequest(BaseModel):
    strategy: str = Field(..., min_length=1, max_length=64)
    symbol: str = Field(..., min_length=1, max_length=12)
    timeframe: Timeframe = Timeframe.M15
    start_date: str = Field(..., description="ISO date (YYYY-MM-DD)")
    end_date: str = Field(..., description="ISO date (YYYY-MM-DD)")
    initial_capital: float = Field(100_000.0, gt=0, le=1e12)
    params: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("symbol")
    @classmethod
    def _norm_symbol(cls, v: str) -> str:
        return v.strip().upper()

    @field_validator("start_date", "end_date")
    @classmethod
    def _check_date(cls, v: str) -> str:
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError as e:
            raise ValueError("date must be in YYYY-MM-DD format") from e
        return v

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "strategy": "smi-mid",
            "symbol": "SPY",
            "timeframe": "15m",
            "start_date": "2025-01-01",
            "end_date": "2025-06-30",
            "initial_capital": 100_000.0,
            "params": {"smi_period": 14},
        }
    })


class BacktestTrade(BaseModel):
    entry_time: datetime
    exit_time: Optional[datetime] = None
    side: OrderSide
    entry_price: float
    exit_price: Optional[float] = None
    quantity: float
    pnl: Optional[float] = None
    pnl_pct: Optional[float] = None


class BacktestResult(BaseModel):
    id: str
    strategy: str
    symbol: str
    timeframe: str
    start_date: str
    end_date: str
    initial_capital: float
    final_capital: float
    total_return: float
    total_return_pct: float
    max_drawdown: float
    max_drawdown_pct: float
    sharpe_ratio: float
    win_rate: float
    total_trades: int
    winning_trades: int
    losing_trades: int
    avg_win: float
    avg_loss: float
    profit_factor: float
    trades: List[BacktestTrade]
    equity_curve: List[Dict[str, Any]]
    smi_data: List[Dict[str, Any]] = []
    status: str = "completed"
    created_at: datetime = None

    def __init__(self, **data):
        if data.get("created_at") is None:
            data["created_at"] = datetime.utcnow()
        super().__init__(**data)


class WSMessage(BaseModel):
    type: str
    data: Dict[str, Any]


# ── Options endpoints ─────────────────────────────────────────────────

class OptionContract(BaseModel):
    """One leg of an option chain. Greeks are populated only when the
    chain is requested for a specific expiration (per-contract reqMktData
    is too heavy to do across every strike)."""

    strike: float
    expiry: str = Field(..., description="YYYYMMDD")
    bid: Optional[float] = None
    ask: Optional[float] = None
    last: Optional[float] = None
    iv: Optional[float] = None
    delta: Optional[float] = None
    gamma: Optional[float] = None
    theta: Optional[float] = None
    vega: Optional[float] = None
    oi: Optional[int] = Field(None, description="Open interest")
    vol: Optional[int] = Field(None, description="Today's volume")

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "strike": 460.0,
            "expiry": "20260619",
            "bid": 5.10, "ask": 5.25, "last": 5.18,
            "iv": 0.18, "delta": 0.45, "gamma": 0.02,
            "theta": -0.08, "vega": 0.55,
            "oi": 12340, "vol": 4221,
        }
    })


class OptionChain(BaseModel):
    """Option-chain payload. When ``expiration`` was omitted on the
    request, ``calls`` and ``puts`` are empty and only ``expirations`` +
    ``strikes`` are populated (the lightweight discovery shape)."""

    symbol: str
    expirations: List[str] = Field(default_factory=list, description="Available YYYYMMDD expiries.")
    strikes: List[float] = Field(default_factory=list)
    calls: List[OptionContract] = Field(default_factory=list)
    puts: List[OptionContract] = Field(default_factory=list)

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "symbol": "SPY",
            "expirations": ["20260619", "20260918"],
            "strikes": [450.0, 455.0, 460.0],
            "calls": [
                {
                    "strike": 460.0, "expiry": "20260619",
                    "bid": 5.10, "ask": 5.25, "last": 5.18,
                    "iv": 0.18, "delta": 0.45, "gamma": 0.02,
                    "theta": -0.08, "vega": 0.55, "oi": 12340, "vol": 4221,
                }
            ],
            "puts": [],
        }
    })


class SpreadSpec(BaseModel):
    """Static trade-type criteria — the screener's pass/fail thresholds."""

    name: str
    underlying: str
    max_delta: float
    min_adj_distance_pct: float
    target_aroc_pct: float
    min_kelly_pct: float
    delta_exit: float
    floor_required: bool
    description: str

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "name": "rut",
            "underlying": "RUT",
            "max_delta": 0.10,
            "min_adj_distance_pct": 11.0,
            "target_aroc_pct": 48.0,
            "min_kelly_pct": 20.0,
            "delta_exit": 0.30,
            "floor_required": True,
            "description": "Traditional RUT — Δ ≤ 10, 2 fib floors below money required",
        }
    })


class SpreadCandidate(BaseModel):
    """One credit-spread candidate emitted by the screener. Extra fields
    are allowed because spread_finder enriches the dict per trade type
    (fib floors, runner-up legs, etc)."""

    short_strike: float
    long_strike: float
    expiry: str = Field(..., description="YYYYMMDD")
    credit: Optional[float] = None
    short_delta: Optional[float] = None
    adj_distance_pct: Optional[float] = None
    aroc_pct: Optional[float] = None
    kelly_pct: Optional[float] = None

    model_config = ConfigDict(extra="allow", json_schema_extra={
        "example": {
            "short_strike": 1900.0,
            "long_strike": 1880.0,
            "expiry": "20260619",
            "credit": 2.30,
            "short_delta": 0.09,
            "adj_distance_pct": 11.8,
            "aroc_pct": 53.1,
            "kelly_pct": 28.4,
        }
    })


class SpreadScanResponse(BaseModel):
    """Result of /api/options/spreads/scan.

    Mirrors ``spread_finder.scan``'s actual return shape. Nested per-type
    buckets in ``trade_types`` / ``top_picks`` keep dict-typing because
    each trade type enriches with different fields (fib floors, scale
    notes, runner-ups). Use ``extra="allow"`` so additions in the
    screener don't break the response model."""

    symbol: str
    underlyings_scanned: List[str] = Field(default_factory=list)
    underlying_prices: Dict[str, Optional[float]] = Field(default_factory=dict)
    expirations_scanned: Dict[str, List[str]] = Field(default_factory=dict)
    errors: Optional[List[Dict[str, Any]]] = None
    as_of: datetime
    trade_types: Dict[str, List[SpreadCandidate]] = Field(default_factory=dict)
    top_picks: Dict[str, Optional[SpreadCandidate]] = Field(default_factory=dict)
    recommendation: Optional[Dict[str, Any]] = None

    model_config = ConfigDict(extra="allow", json_schema_extra={
        "example": {
            "symbol": "RUT",
            "underlyings_scanned": ["RUT"],
            "underlying_prices": {"RUT": 2010.5},
            "expirations_scanned": {"RUT": ["20260619"]},
            "errors": None,
            "as_of": "2026-05-23T14:32:11Z",
            "trade_types": {
                "rut": [
                    {
                        "short_strike": 1900.0, "long_strike": 1880.0,
                        "expiry": "20260619", "credit": 2.30,
                        "short_delta": 0.09, "adj_distance_pct": 11.8,
                        "aroc_pct": 53.1, "kelly_pct": 28.4,
                    }
                ],
                "mars": [],
            },
            "top_picks": {
                "rut": {
                    "short_strike": 1900.0, "long_strike": 1880.0,
                    "expiry": "20260619", "credit": 2.30,
                    "short_delta": 0.09, "aroc_pct": 53.1,
                },
                "mars": None,
            },
            "recommendation": {
                "trade_type": "rut",
                "candidate": {"short_strike": 1900.0, "long_strike": 1880.0},
                "reason": "Only RUT qualifies — sole pick.",
                "runner_up_type": None,
                "span_pct": 0.0,
            },
        }
    })


# ── Portfolio extras ──────────────────────────────────────────────────

class SpreadPosition(BaseModel):
    """Multi-leg option spread. Currently emitted by the strategy engine
    when it is enabled; the /api/spreads endpoint returns an empty list
    otherwise."""

    id: str
    symbol: str
    trade_type: str = Field(..., description="rut | mars | marsmax | space | custom")
    side: Literal["put", "call"] = "put"
    short_strike: float
    long_strike: float
    expiry: str = Field(..., description="YYYYMMDD")
    contracts: int = 1
    credit: float
    unrealized_pnl: Optional[float] = None

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "id": "spr_2026A19_RUT_1900_1880",
            "symbol": "RUT",
            "trade_type": "rut",
            "side": "put",
            "short_strike": 1900.0,
            "long_strike": 1880.0,
            "expiry": "20260619",
            "contracts": 1,
            "credit": 2.30,
            "unrealized_pnl": 145.00,
        }
    })


# ── Monitor / scheduler ───────────────────────────────────────────────

class MonitorRefreshRequest(BaseModel):
    """Optional payload for triggering an exit-monitor refresh.

    The body is optional — clients can POST an empty body. When supplied,
    unknown fields are rejected so typos don't silently no-op."""

    note: Optional[str] = Field(
        None, max_length=200,
        description="Free-form human note logged with the manual refresh.",
    )

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"example": {"note": "checking after IBKR reconnect"}},
    )


class PreflightRunRequest(BaseModel):
    """Optional payload for the manual pre-flight scan trigger."""

    scope: Literal["manual", "scheduled", "test"] = Field(
        "manual",
        description="Tag stored alongside the scan result for later filtering.",
    )

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"example": {"scope": "manual"}},
    )


class MonitorRefreshResponse(BaseModel):
    """Result of forcing the exit-monitor to re-evaluate every open spread."""

    ran_at: datetime
    spreads_checked: int = 0
    alerts: List[Dict[str, Any]] = Field(default_factory=list)

    model_config = ConfigDict(extra="allow", json_schema_extra={
        "example": {"ran_at": "2026-05-23T14:32:11Z", "spreads_checked": 3, "alerts": []}
    })


class PreflightRunResponse(BaseModel):
    """Result of forcing the monthly 3rd-Friday pre-flight scan."""

    ran_at: datetime
    scope: str = "manual"
    scan: Optional[Dict[str, Any]] = None

    model_config = ConfigDict(extra="allow", json_schema_extra={
        "example": {"ran_at": "2026-05-23T14:32:11Z", "scope": "manual", "scan": {"symbol": "RUT", "candidates": []}}
    })


# ── Agents (heavy LangGraph debate) ───────────────────────────────────

class AgentAnalyzeRequest(BaseModel):
    """One run of the tradingagents multi-agent debate for one symbol."""

    symbol: str = Field(..., min_length=1, max_length=12, description="Underlying ticker.")
    trade_date: Optional[str] = Field(
        None, description="ISO date YYYY-MM-DD; defaults to today UTC.",
    )

    @field_validator("symbol")
    @classmethod
    def _norm(cls, v: str) -> str:
        return v.strip().upper()

    @field_validator("trade_date")
    @classmethod
    def _check_date(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError as e:
            raise ValueError("trade_date must be YYYY-MM-DD") from e
        return v

    model_config = ConfigDict(json_schema_extra={
        "example": {"symbol": "TSLA", "trade_date": "2026-05-23"}
    })


class AgentStatusResponse(BaseModel):
    installed: bool = Field(..., description="True if the tradingagents package importable.")
    has_openai_key: bool = False
    has_anthropic_key: bool = False
    has_google_key: bool = False


# ── OKW trade tracker ─────────────────────────────────────────────────

OkwTradeType = Literal["rut", "mars", "marsmax", "space", "custom"]


class OkwTradeCreate(BaseModel):
    """Open a new OKW-tracked credit spread."""

    symbol: str = Field(
        ...,
        min_length=1,
        max_length=12,
        pattern=r"^[A-Z0-9\.\-]+$",
        description="Uppercase ticker (1-12 chars). Only A-Z, 0-9, '.' and '-'.",
    )
    trade_type: OkwTradeType = Field(
        ..., description="rut | mars | marsmax | space | custom",
    )
    side: Literal["put", "call"] = "put"
    expiry: str = Field(
        ...,
        pattern=r"^\d{8}$",
        description="YYYYMMDD",
    )
    dte: int = Field(..., ge=0, le=365)
    short_strike: float = Field(..., gt=0, le=1_000_000)
    long_strike: float = Field(..., gt=0, le=1_000_000)
    contracts: int = Field(1, ge=1, le=1000)
    credit: float = Field(
        ..., gt=0, le=10_000,
        description="Per-contract credit at open (positive USD).",
    )
    spot_at_open: Optional[float] = Field(None, gt=0, le=1_000_000)
    short_delta: Optional[float] = Field(None, ge=-1.0, le=1.0)
    aroc_pct: Optional[float] = Field(None, ge=-1000.0, le=1000.0)
    kelly_pct: Optional[float] = Field(None, ge=-1000.0, le=1000.0)
    adj_distance_pct: Optional[float] = Field(None, ge=-1000.0, le=1000.0)
    fib_floor1: Optional[float] = Field(None, gt=0, le=1_000_000)
    fib_floor2: Optional[float] = Field(None, gt=0, le=1_000_000)
    notes: Optional[str] = Field(None, max_length=2000)

    @field_validator("symbol", mode="before")
    @classmethod
    def _norm_symbol(cls, v: Any) -> Any:
        return v.strip().upper() if isinstance(v, str) else v

    @field_validator("trade_type", mode="before")
    @classmethod
    def _norm_trade_type(cls, v: Any) -> Any:
        return v.strip().lower() if isinstance(v, str) else v

    @field_validator("expiry")
    @classmethod
    def _check_expiry(cls, v: str) -> str:
        try:
            datetime.strptime(v, "%Y%m%d")
        except ValueError as e:
            raise ValueError("expiry must be a real calendar date in YYYYMMDD form") from e
        return v

    @model_validator(mode="after")
    def _check_strikes(self) -> "OkwTradeCreate":
        if self.short_strike == self.long_strike:
            raise ValueError("short_strike and long_strike must differ")
        if self.side == "put" and self.long_strike >= self.short_strike:
            raise ValueError("for a put credit spread, long_strike must be below short_strike")
        if self.side == "call" and self.long_strike <= self.short_strike:
            raise ValueError("for a call credit spread, long_strike must be above short_strike")
        return self

    @property
    def width(self) -> float:
        return abs(self.short_strike - self.long_strike)

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "symbol": "RUT", "trade_type": "rut", "side": "put",
            "expiry": "20260619", "dte": 27,
            "short_strike": 1900.0, "long_strike": 1880.0,
            "contracts": 1, "credit": 2.30, "spot_at_open": 2010.5,
            "short_delta": 0.12, "aroc_pct": 11.5,
        }
    })


class OkwTradeClose(BaseModel):
    """Close an open OKW spread and record the realized P&L."""

    exit_reason: Literal["delta", "2pct", "profit", "manual"] = Field(
        ..., description="What triggered the close.",
    )
    realized_pnl: Optional[float] = Field(
        None, ge=-1_000_000, le=1_000_000,
        description="Per-contract realized P&L (USD).",
    )

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "example": {"exit_reason": "profit", "realized_pnl": 1.65}
        },
    )


# ── Chat (Claude side panel) ──────────────────────────────────────────

class ChatMessage(BaseModel):
    role: Literal["user", "assistant"] = Field(..., description="Author of the message.")
    content: str = Field(..., min_length=1)


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(..., min_length=1)
    context: Optional[Dict[str, Any]] = Field(
        None, description="Cached app context — current page, last backtest, open positions, etc.",
    )
    effort: Optional[Literal["low", "medium", "high", "xhigh", "max"]] = "high"

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "messages": [
                {"role": "user", "content": "Why is the SMI strategy down today?"}
            ],
            "context": {"page": "/strategies", "open_positions": 3},
            "effort": "high",
        }
    })


class ChatStatusResponse(BaseModel):
    available: bool
    model: str
