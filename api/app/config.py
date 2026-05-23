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

    @property
    def cors_origins(self) -> List[str]:
        return [s.strip() for s in self.cors_origins_raw.split(",") if s.strip()]


settings = Settings()
