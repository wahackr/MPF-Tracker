# Main business logis here
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from .libs.jobs import claim_next_crawler_job, process_backfill_job, process_sync_job
from .libs.pgsql.main import get_engine

PROVIDER_ALL = "all"
PROVIDER_HSBC = "hsbc"
PROVIDER_MANULIFE = "manulife"
VALID_PROVIDERS = {PROVIDER_ALL, PROVIDER_HSBC, PROVIDER_MANULIFE}

handlers = {
    "sync": process_sync_job,
    "backfill": process_backfill_job,
}


def main(config) -> None:

    # todo: implement main business logic here
    # 1. Initialize database connection
    pg_engine = get_engine(config)

    # 2. claim job
    claimed_job = claim_next_crawler_job(
        pg_engine, lease_seconds=60
    )  # example lease_seconds value

    handler = handlers.get(claimed_job["job_type"])
    result_payload = handler(config, pg_engine, claimed_job["request"])


def _parse_date(value: Any) -> date | None:
    """Parse an ISO date string into ``date``.

    Args:
        value: Raw value that may be a ``date`` or ``YYYY-MM-DD`` string.

    Returns:
        Parsed date on success, otherwise ``None``.
    """
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None
