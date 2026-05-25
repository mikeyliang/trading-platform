from pydantic import BaseModel
from typing import Optional, List, Dict, Any
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


class Trade(BaseModel):
    id: str
    symbol: str
    side: OrderSide
    quantity: float
    price: float
    pnl: Optional[float] = None
    timestamp: datetime
    strategy: Optional[str] = None


class WatchlistItem(BaseModel):
    symbol: str
    sector: str
    name: str
    last: Optional[float] = None
    change: Optional[float] = None        # absolute $ change vs. previous close
    change_pct: Optional[float] = None
    volume: Optional[float] = None


class WatchlistAddRequest(BaseModel):
    symbol: str
    sector: Optional[str] = "Unknown"
    name: Optional[str] = None


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


class StrategyStartRequest(BaseModel):
    symbols: List[str]
    timeframe: str = "15m"
    params: Dict[str, Any] = {}


class BacktestRequest(BaseModel):
    strategy: str
    symbol: str
    timeframe: str
    start_date: str
    end_date: str
    initial_capital: float = 100_000.0
    params: Dict[str, Any] = {}


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
