from __future__ import annotations

from pathlib import Path
import sys

import pytest


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs import settings  # type: ignore[import-not-found]


def test_bool_int_float_and_path_helpers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("X_BOOL", "YES")
    monkeypatch.setenv("X_INT", "42")
    monkeypatch.setenv("X_FLOAT", "3.5")
    monkeypatch.setenv("X_PATH", "~/tmp")

    assert settings._bool_env("X_BOOL", False) is True
    assert settings._int_env("X_INT", 0) == 42
    assert settings._float_env("X_FLOAT", 0.0) == 3.5
    assert settings._path_env("X_PATH", Path("/fallback")) == Path("~/tmp").expanduser()


def test_default_fixture_dir_prefers_existing_container_path(monkeypatch: pytest.MonkeyPatch) -> None:
    class _FakePath:
        def __init__(self, value: str) -> None:
            self._value = value
            self.parents = []

        def exists(self) -> bool:
            return self._value == "/app/mpf-codex-handoff/fixtures"

        def resolve(self) -> _FakePath:
            return self

        def __truediv__(self, _other: str) -> _FakePath:
            return _FakePath(f"{self._value}/child")

    monkeypatch.setattr(settings, "Path", _FakePath)
    result = settings._default_fixture_dir()
    assert str(result._value) == "/app/mpf-codex-handoff/fixtures"


def test_get_settings_reads_env_and_builds_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    settings.get_settings.cache_clear()
    monkeypatch.setenv("DB_HOST", "db-host")
    monkeypatch.setenv("DB_PORT", "6543")
    monkeypatch.setenv("DB_NAME", "db-name")
    monkeypatch.setenv("DB_USER", "db-user")
    monkeypatch.setenv("DB_PASSWORD", "db-pass")
    monkeypatch.setenv("CRAWLER_USE_FIXTURES", "1")
    monkeypatch.setenv("CRAWLER_FIXTURE_DIR", "/tmp/fx")
    monkeypatch.setenv("WORKER_POLL_INTERVAL_SECONDS", "4")
    monkeypatch.setenv("WORKER_LEASE_SECONDS", "120")
    monkeypatch.setenv("WORKER_HEARTBEAT_SECONDS", "5")

    cfg = settings.get_settings()
    assert cfg.db_host == "db-host"
    assert cfg.db_port == 6543
    assert cfg.db_name == "db-name"
    assert cfg.db_user == "db-user"
    assert cfg.db_password == "db-pass"
    assert cfg.crawler_use_fixtures is True
    assert cfg.crawler_fixture_dir == Path("/tmp/fx")
    assert cfg.worker_poll_interval_seconds == 4.0
    assert cfg.worker_lease_seconds == 120
    assert cfg.worker_heartbeat_seconds == 5.0
    assert cfg.database_url == "postgresql+psycopg://db-user:db-pass@db-host:6543/db-name"
    settings.get_settings.cache_clear()
