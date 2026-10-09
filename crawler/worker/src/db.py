from __future__ import annotations

from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from .settings import get_settings


@lru_cache
def _engine_for_url(database_url: str) -> Engine:
    return create_engine(database_url, future=True, pool_pre_ping=True)


def get_engine() -> Engine:
    settings = get_settings()
    return _engine_for_url(settings.database_url)


@contextmanager
def begin_connection() -> Connection:
    with get_engine().begin() as connection:
        yield connection


def ping_database() -> bool:
    try:
        with get_engine().connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except SQLAlchemyError:
        return False
