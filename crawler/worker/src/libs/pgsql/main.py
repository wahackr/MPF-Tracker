from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine, URL
from sqlalchemy.exc import SQLAlchemyError


def get_engine(config) -> Engine:
    database_url = URL.create(
        "postgresql+psycopg",
        username=config["PGSQL_USER"],
        password=config["PGSQL_PASSWORD"],
        host=config["PGSQL_HOST"],
        port=int(config["PGSQL_PORT"]),
        database=config["PGSQL_DB_NAME"],
    )
    return create_engine(database_url, pool_pre_ping=True)


@contextmanager
def begin_connection(engine) -> Iterator[Connection]:
    with engine.begin() as connection:
        yield connection


def ping_database(engine: Engine) -> bool:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except SQLAlchemyError:
        return False
