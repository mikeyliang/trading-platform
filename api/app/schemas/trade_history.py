"""
Pydantic schemas for trade history API.
"""
from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from typing import Optional, List


class TradeHistoryBase(BaseModel):
    """Base schema for trade history."""
    symbol: str = Field(..., min_length=1, max_length=20)
    side: str
    quantity: float = Field(..., gt=0)
    price: float = Field(..., gt=0)
    order_type: str = Field(default='market')
    strategy: Optional[str] = Field(None, max_length=100)
    agent_id: Optional[str] = Field(None, max_length=100)
    metadata_: Optional[dict] = None
    
    @field_validator('side')
    @classmethod
    def validate_side(cls, v):
        if v not in ('buy', 'sell'):
            raise ValueError('side must be "buy" or "sell"')
        return v
    
    @field_validator('order_type')
    @classmethod
    def validate_order_type(cls, v):
        if v not in ('market', 'limit', 'stop'):
            raise ValueError('order_type must be "market", "limit", or "stop"')
        return v


class TradeHistoryCreate(TradeHistoryBase):
    """Schema for creating a new trade history record."""
    status: str = Field(default='filled')
    timestamp: Optional[datetime] = None
    
    @field_validator('status')
    @classmethod
    def validate_status(cls, v):
        if v not in ('filled', 'partial', 'cancelled'):
            raise ValueError('status must be "filled", "partial", or "cancelled"')
        return v
    
    class Config:
        json_schema_extra = {
            "example": {
                "symbol": "AAPL",
                "side": "buy",
                "quantity": 100,
                "price": 150.50,
                "order_type": "market",
                "strategy": "momentum",
                "agent_id": "agent_001",
                "status": "filled"
            }
        }


class TradeHistoryUpdate(BaseModel):
    """Schema for updating a trade (e.g., adding P&L)."""
    pnl: Optional[float] = None
    pnl_percentage: Optional[float] = None
    status: Optional[str] = None
    metadata_: Optional[dict] = None
    
    @field_validator('status')
    @classmethod
    def validate_status(cls, v):
        if v is not None and v not in ('filled', 'partial', 'cancelled'):
            raise ValueError('status must be "filled", "partial", or "cancelled"')
        return v


class TradeHistoryResponse(TradeHistoryBase):
    """Schema for trade history response."""
    id: int
    timestamp: datetime
    status: str
    pnl: Optional[float] = None
    pnl_percentage: Optional[float] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "id": 1,
                "symbol": "AAPL",
                "side": "buy",
                "quantity": 100,
                "price": 150.50,
                "order_type": "market",
                "status": "filled",
                "pnl": 250.00,
                "pnl_percentage": 1.66,
                "strategy": "momentum",
                "agent_id": "agent_001",
                "timestamp": "2024-01-15T10:30:00Z",
                "created_at": "2024-01-15T10:30:00Z",
                "updated_at": "2024-01-15T11:00:00Z"
            }
        }


class TradeStats(BaseModel):
    """Schema for trade statistics."""
    total_trades: int
    winning_trades: int
    losing_trades: int
    win_rate: float
    total_pnl: float
    avg_pnl: float
    profit_factor: float
    avg_holding_time_minutes: Optional[float] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "total_trades": 150,
                "winning_trades": 85,
                "losing_trades": 65,
                "win_rate": 56.67,
                "total_pnl": 12500.50,
                "avg_pnl": 83.34,
                "profit_factor": 1.85,
                "avg_holding_time_minutes": 45.5
            }
        }


class TradeHistoryListResponse(BaseModel):
    """Schema for paginated trade history list."""
    trades: List[TradeHistoryResponse]
    total: int
    page: int
    page_size: int
    total_pages: int
