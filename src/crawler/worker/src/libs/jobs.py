import json
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


def heartbeat_claim(
    pg_engine,
    *,
    job_id: UUID,
    attempts: int,
    lease_seconds: int,
) -> bool:
    with begin_connection(pg_engine) as pg_connection:
        result = pg_connection.execute(
            text("""
                UPDATE mpf.jobs
                SET heartbeat_at = NOW(),
                    lease_until = NOW() + (:lease_seconds * INTERVAL '1 second'),
                    updated_at = NOW()
                WHERE job_id = :job_id
                  AND status = 'running'
                  AND attempts = :attempts
                """),
            {
                "job_id": str(job_id),
                "attempts": attempts,
                "lease_seconds": lease_seconds,
            },
        )
        return result.rowcount > 0


def complete_claimed_job(
    pg_engine,
    *,
    job_id: UUID,
    attempts: int,
    result_payload: dict[str, Any],
) -> bool:
    with begin_connection(pg_engine) as pg_connection:
        result = pg_connection.execute(
            text("""
                UPDATE mpf.jobs
                SET
                    status = :status,
                    result = CAST(:result AS JSONB),
                    error_message = NULL,
                    lease_until = NULL,
                    heartbeat_at = NOW(),
                    updated_at = NOW()
                WHERE job_id = :job_id
                  AND status = 'running'
                  AND attempts = :attempts
                """),
            {
                "job_id": str(job_id),
                "attempts": attempts,
                "status": (
                    "partial" if _has_fund_failures(result_payload) else "succeeded"
                ),
                "result": json.dumps(result_payload, default=_json_default),
            },
        )
        return result.rowcount > 0


def fail_claimed_job(
    pg_engine, *, job_id: UUID, attempts: int, error_message: str
) -> bool:
    with begin_connection(pg_engine) as pg_connection:
        result = pg_connection.execute(
            text("""
                UPDATE mpf.jobs
                SET
                    status = :status,
                    error_message = :error_message,
                    lease_until = CASE WHEN :status = 'queued'
                        THEN NOW() + (:retry_delay_seconds * INTERVAL '1 second')
                        ELSE NULL END,
                    heartbeat_at = NOW(),
                    updated_at = NOW()
                WHERE job_id = :job_id
                  AND status = 'running'
                  AND attempts = :attempts
                """),
            {
                "job_id": str(job_id),
                "attempts": attempts,
                "status": "queued" if attempts < MAX_ATTEMPTS else "failed",
                "retry_delay_seconds": 30 * attempts,
                "error_message": error_message[:4000],
            },
        )
        return result.rowcount > 0


def _has_fund_failures(result_payload: dict[str, Any]) -> bool:
    if result_payload.get("funds_failed"):
        return True

    return any(
        isinstance(provider_result, dict) and bool(provider_result.get("funds_failed"))
        for provider_result in result_payload.values()
    )


def _json_default(value: Any) -> str:
    if isinstance(value, (date, datetime, UUID)):
        return value.isoformat() if not isinstance(value, UUID) else str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


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
        pg_engine=pg_engine,
    )


def process_backfill_job(config, pg_engine, payload: dict[str, Any]) -> dict[str, Any]:
    provider = payload["provider"]
    from_date = _parse_date(payload.get("from_date"))
    to_date = _parse_date(payload.get("to_date"))
    if from_date is None or to_date is None:
        raise ValueError("from_date and to_date are required for backfill")
    if from_date > to_date:
        raise ValueError("from_date must be <= to_date")

    return run_job(
        provider=provider,
        from_date=from_date,
        to_date=to_date,
        pg_engine=pg_engine,
    )


def run_job(
    *,
    provider: str,
    from_date: date,
    to_date: date,
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

    results_by_provider: dict[str, Any] = {}

    if PROVIDER_HSBC in providers:

        # crawl HSBC data
        results = crawl_hsbc(from_date=from_date, to_date=to_date)

        # parse HSBC CSV payload into structured records
        records = parse_all_hsbc_funds_csv(results["payload"])
        results_by_provider[PROVIDER_HSBC] = save_hsbc_records(pg_engine, records)

    if PROVIDER_MANULIFE in providers:
        crawl_result = crawl_manulife(
            from_date=from_date,
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
