from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List


class Settings(BaseSettings):
    """Single source of truth for runtime config.

    IBKR Gateway is the only market-data + brokerage source. No Polygon /
    Massive / Finnhub / yfinance fallbacks — chains, bars, and quotes come
    from the gateway. ``mock_mode`` enables synthetic data when the gateway
    is unavailable (development only).
    """

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False, extra="ignore")

    # IBKR Gateway
    ib_gateway_host: str = "ib-gateway"
    ib_gateway_port: int = 4003
    ib_client_id: int = 1
    trading_mode: str = "paper"

    secret_key: str = "dev-secret-key"
    cors_origins_raw: str = Field(
        default="http://localhost:3000,http://localhost:3001",
        alias="CORS_ORIGINS",
    )

    log_level: str = "INFO"
    mock_mode: bool = True

    # Security: when True, CORS uses the cors_origins allowlist and credentials
    # are permitted. When False (development), allows all origins with no creds.
    production_mode: bool = False

    # Rate limit: max requests per client IP per ``rate_limit_window_seconds``.
    # Counts are in-process, so this is per-uvicorn-worker. For multi-worker
    # deployment use a Redis-backed limiter instead.
    rate_limit_requests: int = 120
    rate_limit_window_seconds: int = 60
    # Paths excluded from rate limiting — health/probe endpoints and the WS
    # endpoint (which handles its own subscription throttling).
    rate_limit_exempt_paths: str = "/health,/,/ws"

    # Input sanitization: hard cap on any single string field/query param. Stops
    # accidental and adversarial megabyte-string payloads from reaching pydantic.
    max_string_length: int = 10_000

    # Postgres connection for scan history + future durable state.
    database_url: str = "postgresql://trading:trading@postgres:5432/trading"

    # MinIO (S3-compatible) for asset caching — logos today, more later.
    minio_endpoint: str = "http://minio:9000"
    minio_access_key: str = "minio"
    minio_secret_key: str = "minio12345"
    minio_bucket: str = "logos"

    # Claude API for the assistant / multi-agent debate
    anthropic_api_key: str = ""
    chat_model: str = "claude-opus-4-7"

    # Equity research desk (multi-agent runs). Deep model drives the
    # researcher debate / trader / risk / portfolio-manager calls; quick
    # model drives the parallel analyst reads. Both default to the most
    # capable model — point equity_quick_model at a cheaper model (e.g.
    # claude-haiku-4-5) to trade quality for cost on the analyst tier.
    equity_deep_model: str = "claude-opus-4-8"
    equity_quick_model: str = "claude-opus-4-8"

    # Credits: signup grant for new accounts; Stripe key reserved for
    # real checkout (empty = dev mode, packs grant instantly).
    free_signup_credits: int = 25
    stripe_secret_key: str = ""

    # Shared secret that callers of /api/agent/* must send as X-Agent-Key.
    # Empty disables auth (dev only) — production deployments must set this.
    agent_api_key: str = ""

    @property
    def cors_origins(self) -> List[str]:
        return [s.strip() for s in self.cors_origins_raw.split(",") if s.strip()]


settings = Settings()
