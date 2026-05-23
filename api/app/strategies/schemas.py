"""
Pydantic configs for tunable strategies. Each model is exposed via
/api/strategies/{id}/schema so the frontend can render a parameter form
without hand-writing per-strategy UI.

Use Field(description=..., ge=..., le=..., examples=...) to give the UI:
  - label (from field name or json_schema_extra.title)
  - help text (description)
  - bounds for sliders/steppers
  - group via json_schema_extra.group
"""
from typing import Literal, Optional
from pydantic import BaseModel, Field


class SmiStrategyConfig(BaseModel):
    """SMI + EMA crossover strategy parameters."""

    smi_period: int = Field(
        13, ge=5, le=50,
        description="Lookback bars for high/low range",
        json_schema_extra={"group": "SMI", "title": "SMI period"},
    )
    smooth1: int = Field(
        25, ge=2, le=50,
        description="First EMA smoothing pass",
        json_schema_extra={"group": "SMI", "title": "Smoothing 1"},
    )
    smooth2: int = Field(
        2, ge=1, le=20,
        description="Second EMA smoothing pass",
        json_schema_extra={"group": "SMI", "title": "Smoothing 2"},
    )
    signal: int = Field(
        9, ge=2, le=30,
        description="Signal line EMA period",
        json_schema_extra={"group": "SMI", "title": "Signal EMA"},
    )
    smi_overbought: float = Field(
        40.0, ge=10.0, le=80.0,
        description="Upper SMI threshold for sells",
        json_schema_extra={"group": "Thresholds", "title": "Overbought"},
    )
    smi_oversold: float = Field(
        -40.0, ge=-80.0, le=-10.0,
        description="Lower SMI threshold for buys",
        json_schema_extra={"group": "Thresholds", "title": "Oversold"},
    )
    ema_fast: int = Field(
        9, ge=2, le=50,
        description="Trend filter fast EMA",
        json_schema_extra={"group": "Trend filter", "title": "EMA fast"},
    )
    ema_slow: int = Field(
        21, ge=5, le=200,
        description="Trend filter slow EMA",
        json_schema_extra={"group": "Trend filter", "title": "EMA slow"},
    )


class BullPutSpreadStrategyConfig(BaseModel):
    """Bull put spread automation parameters (matches BullPutSpreadConfig)."""

    symbol: Literal["SPY", "QQQ", "IWM", "RUT", "SPX", "NDX"] = Field(
        "SPY",
        description="Underlying to sell spreads on",
        json_schema_extra={"group": "Entry", "title": "Underlying"},
    )
    target_dte_min: int = Field(
        30, ge=1, le=90,
        description="Minimum days to expiration for entry",
        json_schema_extra={"group": "Entry", "title": "Min DTE"},
    )
    target_dte_max: int = Field(
        45, ge=1, le=90,
        description="Maximum days to expiration for entry",
        json_schema_extra={"group": "Entry", "title": "Max DTE"},
    )
    short_delta: float = Field(
        0.25, ge=0.05, le=0.45,
        description="Target |delta| for the short put",
        json_schema_extra={"group": "Entry", "title": "Short delta"},
    )
    wing_width: float = Field(
        5.0, ge=1.0, le=50.0,
        description="Dollars between short and long strikes",
        json_schema_extra={"group": "Entry", "title": "Wing width ($)"},
    )
    quantity: int = Field(
        1, ge=1, le=50,
        description="Contracts per spread",
        json_schema_extra={"group": "Sizing", "title": "Quantity"},
    )
    max_concurrent: int = Field(
        3, ge=1, le=10,
        description="Maximum open spreads at any time",
        json_schema_extra={"group": "Sizing", "title": "Max concurrent"},
    )
    profit_target_pct: float = Field(
        0.50, ge=0.05, le=0.95,
        description="Close at this fraction of max profit",
        json_schema_extra={"group": "Exits", "title": "Profit target (%)"},
    )
    stop_loss_mult: float = Field(
        2.0, ge=1.1, le=5.0,
        description="Close if loss reaches this multiple of credit received",
        json_schema_extra={"group": "Exits", "title": "Stop loss mult"},
    )
    time_stop_dte: int = Field(
        21, ge=0, le=45,
        description="Force-close any spread with DTE <= this",
        json_schema_extra={"group": "Exits", "title": "Time stop DTE"},
    )
    scan_interval_sec: int = Field(
        60, ge=10, le=600,
        description="Seconds between entry/exit scans",
        json_schema_extra={"group": "Runtime", "title": "Scan interval (s)"},
    )
    slippage: float = Field(
        0.05, ge=0.0, le=0.50,
        description="Subtract from mid for entry limit, add for exit limit",
        json_schema_extra={"group": "Runtime", "title": "Slippage ($)"},
    )


# Registry: strategy_id -> Pydantic model
STRATEGY_SCHEMAS: dict[str, type[BaseModel]] = {
    "smi-short": SmiStrategyConfig,
    "smi-mid": SmiStrategyConfig,
    "ema-cross": SmiStrategyConfig,
    "bull-put-spy": BullPutSpreadStrategyConfig,
    "bull-put-rut": BullPutSpreadStrategyConfig,
}


def get_schema(strategy_id: str) -> Optional[dict]:
    """Return the JSON schema for a strategy, or None."""
    model = STRATEGY_SCHEMAS.get(strategy_id)
    if not model:
        return None
    schema = model.model_json_schema()
    # also expose defaults at the top level for the UI
    defaults = {name: f.default for name, f in model.model_fields.items()}
    schema["defaults"] = defaults
    return schema
