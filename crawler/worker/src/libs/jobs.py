from datetime import date, datetime, timedelta
from typing import Any, TypedDict
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import text

from .crawlers.hsbc import crawl as crawl_hsbc
from .crawlers.hsbc import parse_all_funds_csv as parse_all_hsbc_funds_csv
from .crawlers.hsbc import save_records as save_hsbc_records
from .crawlers.manulife import crawl as crawl_manulife
from .crawlers.manulife import save_records as save_manulife_records
from .pgsql.main import begin_connection

MAX_ATTEMPTS = 3
PROVIDER_ALL = "all"
PROVIDER_HSBC = "hsbc"
PROVIDER_MANULIFE = "manulife"
VALID_PROVIDERS = {PROVIDER_ALL, PROVIDER_HSBC, PROVIDER_MANULIFE}


class ClaimedJob(TypedDict):
    job_id: UUID
    job_type: str
    request: dict[str, Any]
    attempts: int
    lease_until: Any


def claim_next_crawler_job(pg_engine, lease_seconds: int) -> ClaimedJob | None:

    with begin_connection(pg_engine) as pg_connection:

        row = (
            pg_connection.execute(
                text("""
              WITH exhausted AS (
                  UPDATE mpf.jobs
                  SET status = 'failed', lease_until = NULL,
                      error_message = COALESCE(error_message, 'Worker lease expired after maximum attempts'),
                      updated_at = NOW()
                  WHERE service = 'crawler' AND status = 'running'
                    AND lease_until < NOW() AND attempts >= :max_attempts
                  RETURNING job_id
              ), candidate AS (
                  SELECT job_id
                  FROM mpf.jobs
                  WHERE service = 'crawler'
                    AND attempts < :max_attempts
                    AND (
                        (status = 'queued' AND (lease_until IS NULL OR lease_until <= NOW()))
                        OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < NOW())
                    )
                  ORDER BY created_at ASC
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1
              )
              UPDATE mpf.jobs AS j
              SET
                  status = 'running',
                  attempts = j.attempts + 1,
                  lease_until = NOW() + (:lease_seconds * INTERVAL '1 second'),
                  heartbeat_at = NOW(),
                  updated_at = NOW(),
                  error_message = NULL
              FROM candidate
              WHERE j.job_id = candidate.job_id
              RETURNING j.job_id, j.job_type, j.request, j.attempts, j.lease_until
              """),
                {"lease_seconds": lease_seconds, "max_attempts": MAX_ATTEMPTS},
            )
            .mappings()
            .first()
        )
        if row is None:
            return None
        return {
            "job_id": row["job_id"],
            "job_type": row["job_type"],
            "request": dict(row["request"] or {}),
            "attempts": int(row["attempts"]),
            "lease_until": row["lease_until"],
        }


def process_sync_job(config, pg_engine, payload: dict[str, Any]) -> dict[str, Any]:

    provider = payload["provider"]
    rolling_days = int(payload.get("rolling_days", 7))
    if rolling_days < 1 or rolling_days > 28:
        raise ValueError("rolling_days must be between 1 and 28")

    today = datetime.now(tz=ZoneInfo("Asia/Hong_Kong")).date()
    from_date = today - timedelta(days=rolling_days - 1)
    to_date = today

    return run_job(
        provider=provider,
        from_date=from_date,
        to_date=to_date,
        manulife_filter_days=None,
        mode="sync",
        config=config,
        pg_engine=pg_engine,
    )


def process_backfill_job(config, pg_engine, payload: dict[str, Any]) -> dict[str, Any]:
    """Run a fixed-date-range backfill crawl job.

    Args:
        payload: Job request payload from ``mpf.jobs.request``.
            Required keys:
                - provider: ``"all"``, ``"hsbc"``, or ``"manulife"``
                - from_date: ``YYYY-MM-DD``
                - to_date: ``YYYY-MM-DD``
            Optional keys:
                - manulife_filter_days: explicit recency cap for Manulife
                  prices; omit it to use the full date range.

    Returns:
        Provider write results. When provider is ``all``, results are keyed
        by provider name.

    Raises:
        KeyError: If ``provider`` is missing from payload.
        ValueError: If provider is invalid, dates are missing/unparseable,
            or ``from_date`` is greater than ``to_date``.
    """
    provider = payload["provider"]
    from_date = _parse_date(payload.get("from_date"))
    to_date = _parse_date(payload.get("to_date"))
    if from_date is None or to_date is None:
        raise ValueError("from_date and to_date are required for backfill")
    if from_date > to_date:
        raise ValueError("from_date must be <= to_date")

    filter_days_raw = payload.get("manulife_filter_days")
    manulife_filter_days = int(filter_days_raw) if filter_days_raw is not None else None
    if manulife_filter_days is not None and manulife_filter_days < 1:
        raise ValueError("manulife_filter_days must be positive")

    return run_job(
        provider=provider,
        from_date=from_date,
        to_date=to_date,
        manulife_filter_days=manulife_filter_days,
        mode="backfill",
        config=config,
        pg_engine=pg_engine,
    )


def run_job(
    *,
    provider: str,
    from_date: date,
    to_date: date,
    manulife_filter_days: int | None,
    mode: str,
    config,
    pg_engine,
) -> dict[str, Any]:

    if provider == PROVIDER_HSBC:
        providers = [PROVIDER_HSBC]
    elif provider == PROVIDER_MANULIFE:
        providers = [PROVIDER_MANULIFE]
    elif provider == PROVIDER_ALL:
        providers = [PROVIDER_HSBC, PROVIDER_MANULIFE]
    else:
        raise ValueError(
            f"provider must be one of: {', '.join(sorted(VALID_PROVIDERS))}"
        )

    if manulife_filter_days is not None and manulife_filter_days < 1:
        raise ValueError("manulife_filter_days must be positive")

    manulife_from_date = from_date
    if PROVIDER_MANULIFE in providers and manulife_filter_days is not None:
        cutoff = datetime.now(tz=ZoneInfo("Asia/Hong_Kong")).date() - timedelta(
            days=manulife_filter_days - 1
        )
        manulife_from_date = max(from_date, cutoff)
        if manulife_from_date > to_date:
            raise ValueError("manulife_filter_days excludes the requested date range")

    results_by_provider: dict[str, Any] = {}

    if PROVIDER_HSBC in providers:

        # crawl HSBC data
        results = crawl_hsbc(from_date=from_date, to_date=to_date)

        # parse HSBC CSV payload into structured records
        records = parse_all_hsbc_funds_csv(results["payload"])
        results_by_provider[PROVIDER_HSBC] = save_hsbc_records(pg_engine, records)

    if PROVIDER_MANULIFE in providers:
        crawl_result = crawl_manulife(
            from_date=manulife_from_date,
            to_date=to_date,
        )
        save_result: dict[str, Any] = save_manulife_records(
            pg_engine, crawl_result["records"]
        )
        save_result["funds_failed"] = crawl_result["funds_failed"]
        results_by_provider[PROVIDER_MANULIFE] = save_result

    if provider == PROVIDER_ALL:
        return results_by_provider
    return results_by_provider[provider]


def _parse_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None
