# just the entry point, config all variables

from __future__ import annotations

import os

from .main import main

PGSQL_HOST = (os.getenv("DB_HOST", "mpf-db"),)
PGSQL_PORT = (os.getenv("DB_PORT", "5432"),)
PGSQL_DB_NAME = (os.getenv("DB_NAME", "mpf"),)
PGSQL_USER = (os.getenv("DB_USER", "mpf_crawler"),)
PGSQL_PASSWORD = (os.getenv("DB_PASSWORD", "REPLACE_ME_CRAWLER_PASSWORD"),)

WORKER_POLL_INTERVAL_SECONDS = (os.getenv("WORKER_POLL_INTERVAL_SECONDS", "2.0"),)
WORKER_LEASE_SECONDS = (os.getenv("WORKER_LEASE_SECONDS", "90"),)
WORKER_HEARTBEAT_SECONDS = (os.getenv("WORKER_HEARTBEAT_SECONDS", "15.0"),)

config = {
    PGSQL_HOST,
    PGSQL_PORT,
    PGSQL_DB_NAME,
    PGSQL_USER,
    PGSQL_PASSWORD,
    WORKER_POLL_INTERVAL_SECONDS,
    WORKER_LEASE_SECONDS,
    WORKER_HEARTBEAT_SECONDS,
}


if __name__ == "__main__":
    main(config)
