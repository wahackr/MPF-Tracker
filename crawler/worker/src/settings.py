from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class Settings:
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    crawler_use_fixtures: bool
    worker_poll_interval_seconds: float
    worker_lease_seconds: int
    worker_heartbeat_seconds: float

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    return float(raw)


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    return int(raw)


@lru_cache
def get_settings() -> Settings:
    return Settings(
        db_host=os.getenv("DB_HOST", "mpf-db"),
        db_port=_int_env("DB_PORT", 5432),
        db_name=os.getenv("DB_NAME", "mpf"),
        db_user=os.getenv("DB_USER", "mpf_crawler"),
        db_password=os.getenv("DB_PASSWORD", "REPLACE_ME_CRAWLER_PASSWORD"),
        crawler_use_fixtures=_bool_env("CRAWLER_USE_FIXTURES", False),
        worker_poll_interval_seconds=_float_env("WORKER_POLL_INTERVAL_SECONDS", 2.0),
        worker_lease_seconds=_int_env("WORKER_LEASE_SECONDS", 90),
        worker_heartbeat_seconds=_float_env("WORKER_HEARTBEAT_SECONDS", 15.0),
    )
