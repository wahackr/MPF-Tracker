from __future__ import annotations

import logging
import os

from .main import main
from .libs.pgsql.main import get_engine, ping_database


config = {
    "PGSQL_HOST": os.getenv("DB_HOST", "mpf-db"),
    "PGSQL_PORT": int(os.getenv("DB_PORT", "5432")),
    "PGSQL_DB_NAME": os.getenv("DB_NAME", "mpf"),
    "PGSQL_USER": os.getenv("DB_USER", "mpf_crawler"),
    "PGSQL_PASSWORD": os.getenv("DB_PASSWORD", "REPLACE_ME_CRAWLER_PASSWORD"),
    "WORKER_POLL_INTERVAL_SECONDS": float(
        os.getenv("WORKER_POLL_INTERVAL_SECONDS", "2.0")
    ),
    "WORKER_LEASE_SECONDS": int(os.getenv("WORKER_LEASE_SECONDS", "90")),
    "WORKER_HEARTBEAT_SECONDS": float(
        os.getenv("WORKER_HEARTBEAT_SECONDS", "15.0")
    ),
}


def healthcheck() -> bool:
    engine = get_engine(config)
    try:
        return ping_database(engine)
    finally:
        engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    main(config)
