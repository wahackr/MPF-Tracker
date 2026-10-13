from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import sys
from types import SimpleNamespace

from sqlalchemy.exc import SQLAlchemyError


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs.pgsql import main as pgsql


CONFIG = {
    "PGSQL_HOST": "db-host",
    "PGSQL_PORT": 5432,
    "PGSQL_DB_NAME": "mpf",
    "PGSQL_USER": "crawler",
    "PGSQL_PASSWORD": "secret",
}


def test_get_engine_uses_database_config(monkeypatch) -> None:
    seen: list[tuple] = []
    monkeypatch.setattr(
        pgsql,
        "create_engine",
        lambda url, **kwargs: seen.append((url, kwargs)) or "ENGINE",
    )

    engine = pgsql.get_engine(CONFIG)

    assert engine == "ENGINE"
    url, options = seen[0]
    assert url.drivername == "postgresql+psycopg"
    assert url.username == "crawler"
    assert url.password == "secret"
    assert url.host == "db-host"
    assert url.port == 5432
    assert url.database == "mpf"
    assert options == {"pool_pre_ping": True}


def test_begin_connection_yields_engine_connection() -> None:
    marker = object()

    @contextmanager
    def fake_begin():
        yield marker

    engine = SimpleNamespace(begin=fake_begin)
    with pgsql.begin_connection(engine) as connection:
        assert connection is marker


def test_ping_database_returns_true_when_query_succeeds() -> None:
    @contextmanager
    def connect():
        yield SimpleNamespace(execute=lambda _statement: None)

    assert pgsql.ping_database(SimpleNamespace(connect=connect)) is True


def test_ping_database_returns_false_when_connection_fails() -> None:
    @contextmanager
    def connect():
        raise SQLAlchemyError("db down")
        yield  # pragma: no cover

    assert pgsql.ping_database(SimpleNamespace(connect=connect)) is False
