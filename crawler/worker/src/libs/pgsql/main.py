from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.engine import Connection, Engine


def get_engine(config) -> Engine:

    engine = create_engine(
        f"postgresql://{config['PGSQL_USER']}:{config['PGSQL_PASSWORD']}@{config['PGSQL_HOST']}:{config['PGSQL_PORT']}/{config['PGSQL_DB_NAME']}"
    )
    return engine


@contextmanager
def begin_connection(engine) -> Iterator[Connection]:
    with engine.begin() as connection:
        yield connection
