from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import sys
from types import SimpleNamespace

from sqlalchemy.exc import SQLAlchemyError


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs import db  # type: ignore[import-not-found]


def test_get_engine_uses_settings_database_url(monkeypatch) -> None:
    monkeypatch.setattr(db, "get_settings", lambda: SimpleNamespace(database_url="postgresql+psycopg://u:p@h:5432/d"))
    seen: list[str] = []
    monkeypatch.setattr(db, "_engine_for_url", lambda url: seen.append(url) or "ENGINE")

    engine = db.get_engine()

    assert engine == "ENGINE"
    assert seen == ["postgresql+psycopg://u:p@h:5432/d"]


def test_begin_connection_yields_engine_begin_connection(monkeypatch) -> None:
    marker = object()

    @contextmanager
    def _fake_begin():
        yield marker

    monkeypatch.setattr(db, "get_engine", lambda: SimpleNamespace(begin=_fake_begin))
    with db.begin_connection() as connection:
        assert connection is marker


def test_ping_database_true_and_false(monkeypatch) -> None:
    @contextmanager
    def _ok_connect():
        yield SimpleNamespace(execute=lambda _stmt: None)

    monkeypatch.setattr(db, "get_engine", lambda: SimpleNamespace(connect=_ok_connect))
    assert db.ping_database() is True

    @contextmanager
    def _failing_connect():
        raise SQLAlchemyError("db down")
        yield  # pragma: no cover

    monkeypatch.setattr(db, "get_engine", lambda: SimpleNamespace(connect=_failing_connect))
    assert db.ping_database() is False
