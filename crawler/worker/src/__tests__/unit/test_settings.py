from __future__ import annotations

from pathlib import Path
import sys

import pytest


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs import settings  # type: ignore[import-not-found]


def test_int_and_float_helpers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("X_INT", "42")
    monkeypatch.setenv("X_FLOAT", "3.5")

    assert settings._int_env("X_INT", 0) == 42
    assert settings._float_env("X_FLOAT", 0.0) == 3.5


def test_get_settings_reads_env_and_builds_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    settings.get_settings.cache_clear()
    monkeypatch.setenv("DB_HOST", "db-host")
    monkeypatch.setenv("DB_PORT", "6543")
    monkeypatch.setenv("DB_NAME", "db-name")
    monkeypatch.setenv("DB_USER", "db-user")
    monkeypatch.setenv("DB_PASSWORD", "db-pass")
    monkeypatch.setenv("WORKER_POLL_INTERVAL_SECONDS", "4")
    monkeypatch.setenv("WORKER_LEASE_SECONDS", "120")
    monkeypatch.setenv("WORKER_HEARTBEAT_SECONDS", "5")

    cfg = settings.get_settings()
    assert cfg.db_host == "db-host"
    assert cfg.db_port == 6543
    assert cfg.db_name == "db-name"
    assert cfg.db_user == "db-user"
    assert cfg.db_password == "db-pass"
    assert cfg.worker_poll_interval_seconds == 4.0
    assert cfg.worker_lease_seconds == 120
    assert cfg.worker_heartbeat_seconds == 5.0
    assert cfg.database_url == "postgresql+psycopg://db-user:db-pass@db-host:6543/db-name"
    settings.get_settings.cache_clear()
