from __future__ import annotations

from datetime import date, datetime
import json
from pathlib import Path
import sys
from unittest.mock import Mock
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine


WORKER_SRC_DIR = Path(__file__).resolve().parents[2]
if str(WORKER_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC_DIR))

from libs import jobs


TEST_JOB_PREFIX = "pytest-worker-"


@pytest.fixture
def jobs_pg_engine(crawler_pg_engine: Engine):
    _delete_test_jobs(crawler_pg_engine)
    yield crawler_pg_engine
    _delete_test_jobs(crawler_pg_engine)


def _delete_test_jobs(pg_engine: Engine) -> None:
    with pg_engine.begin() as connection:
        connection.execute(
            text("DELETE FROM mpf.jobs WHERE idempotency_key LIKE :prefix"),
            {"prefix": f"{TEST_JOB_PREFIX}%"},
        )


def _insert_job(
    pg_engine: Engine,
    *,
    status: str = "queued",
    attempts: int = 0,
    request: dict | None = None,
    lease_offset_seconds: int | None = None,
    error_message: str | None = None,
) -> UUID:
    with pg_engine.begin() as connection:
        return connection.execute(
            text("""
                INSERT INTO mpf.jobs (
                    service, job_type, status, idempotency_key, request,
                    attempts, lease_until, error_message
                )
                VALUES (
                    'crawler', 'sync', :status, :idempotency_key,
                    CAST(:request AS JSONB), :attempts,
                    NOW() + (:lease_offset_seconds * INTERVAL '1 second'),
                    :error_message
                )
                RETURNING job_id
                """),
            {
                "status": status,
                "idempotency_key": f"{TEST_JOB_PREFIX}{uuid4()}",
                "request": json.dumps(request or {"provider": "hsbc"}),
                "attempts": attempts,
                "lease_offset_seconds": lease_offset_seconds,
                "error_message": error_message,
            },
        ).scalar_one()


def _read_job(pg_engine: Engine, job_id: UUID):
    with pg_engine.connect() as connection:
        return (
            connection.execute(
                text("SELECT * FROM mpf.jobs WHERE job_id = :job_id"),
                {"job_id": str(job_id)},
            )
            .mappings()
            .one()
        )


@pytest.mark.parametrize(
    "result_payload",
    [
        {"funds_failed": [{"fund_id": "MANULIFE:SHK122"}]},
        {
            "hsbc": {"inserted": 2},
            "manulife": {"funds_failed": [{"fund_id": "MANULIFE:DIS148"}]},
        },
    ],
)
def test_has_fund_failures_yes(result_payload: dict) -> None:
    assert jobs._has_fund_failures(result_payload) is True


@pytest.mark.parametrize(
    "result_payload",
    [
        {},
        {"funds_failed": []},
        {"hsbc": {"inserted": 2}, "manulife": {"funds_failed": []}},
        {"hsbc": None},
    ],
)
def test_has_fund_failures_no(result_payload: dict) -> None:
    assert jobs._has_fund_failures(result_payload) is False


@pytest.mark.integration
def test_claim_next_crawler_job(jobs_pg_engine: Engine) -> None:
    job_id = _insert_job(
        jobs_pg_engine,
        request={"provider": "manulife", "rolling_days": 7},
    )

    claimed = jobs.claim_next_crawler_job(jobs_pg_engine, lease_seconds=90)

    assert claimed is not None
    assert claimed["job_id"] == job_id
    assert claimed["job_type"] == "sync"
    assert claimed["request"] == {"provider": "manulife", "rolling_days": 7}
    assert claimed["attempts"] == 1
    assert claimed["lease_until"] is not None

    stored = _read_job(jobs_pg_engine, job_id)
    assert stored["status"] == "running"
    assert stored["attempts"] == 1
    assert stored["heartbeat_at"] is not None
    assert stored["lease_until"] == claimed["lease_until"]


@pytest.mark.integration
def test_claim_next_crawler_job_fails_expired_exhausted_job(
    jobs_pg_engine: Engine,
) -> None:
    job_id = _insert_job(
        jobs_pg_engine,
        status="running",
        attempts=jobs.MAX_ATTEMPTS,
        lease_offset_seconds=-60,
    )

    assert jobs.claim_next_crawler_job(jobs_pg_engine, lease_seconds=90) is None

    stored = _read_job(jobs_pg_engine, job_id)
    assert stored["status"] == "failed"
    assert stored["lease_until"] is None
    assert stored["error_message"] == "Worker lease expired after maximum attempts"


@pytest.mark.integration
def test_heartbeat_claim(jobs_pg_engine: Engine) -> None:
    job_id = _insert_job(
        jobs_pg_engine,
        status="running",
        attempts=2,
        lease_offset_seconds=-60,
    )

    assert jobs.heartbeat_claim(
        jobs_pg_engine,
        job_id=job_id,
        attempts=2,
        lease_seconds=90,
    ) is True

    stored = _read_job(jobs_pg_engine, job_id)
    assert stored["status"] == "running"
    assert stored["heartbeat_at"] is not None
    assert stored["lease_until"] > stored["heartbeat_at"]


@pytest.mark.integration
def test_heartbeat_claim_rejects_stale_attempt(jobs_pg_engine: Engine) -> None:
    job_id = _insert_job(jobs_pg_engine, status="running", attempts=2)

    assert jobs.heartbeat_claim(
        jobs_pg_engine,
        job_id=job_id,
        attempts=1,
        lease_seconds=90,
    ) is False


@pytest.mark.integration
def test_complete_claimed_job_all_success(jobs_pg_engine: Engine) -> None:
    job_id = _insert_job(
        jobs_pg_engine,
        status="running",
        attempts=1,
        lease_offset_seconds=60,
        error_message="old error",
    )
    result_payload = {
        "inserted": 2,
        "min_changed_date": date(2026, 10, 1),
        "funds_failed": [],
    }

    assert jobs.complete_claimed_job(
        jobs_pg_engine,
        job_id=job_id,
        attempts=1,
        result_payload=result_payload,
    ) is True

    stored = _read_job(jobs_pg_engine, job_id)
    assert stored["status"] == "succeeded"
    assert stored["result"] == {
        "inserted": 2,
        "min_changed_date": "2026-10-01",
        "funds_failed": [],
    }
    assert stored["error_message"] is None
    assert stored["lease_until"] is None


@pytest.mark.integration
def test_complete_claimed_job_partial_failures(jobs_pg_engine: Engine) -> None:
    job_id = _insert_job(
        jobs_pg_engine,
        status="running",
        attempts=1,
        lease_offset_seconds=60,
    )
    result_payload = {
        "hsbc": {"inserted": 2},
        "manulife": {
            "inserted": 1,
            "funds_failed": [{"fund_id": "MANULIFE:SHK122"}],
        },
    }

    assert jobs.complete_claimed_job(
        jobs_pg_engine,
        job_id=job_id,
        attempts=1,
        result_payload=result_payload,
    ) is True

    stored = _read_job(jobs_pg_engine, job_id)
    assert stored["status"] == "partial"
    assert stored["result"] == result_payload
    assert stored["lease_until"] is None


@pytest.mark.integration
@pytest.mark.parametrize(
    ("attempts", "expected_status", "expected_delay_seconds"),
    [
        (1, "queued", 30),
        (jobs.MAX_ATTEMPTS, "failed", None),
    ],
)
def test_fail_claimed_job(
    jobs_pg_engine: Engine,
    attempts: int,
    expected_status: str,
    expected_delay_seconds: int | None,
) -> None:
    job_id = _insert_job(
        jobs_pg_engine,
        status="running",
        attempts=attempts,
        lease_offset_seconds=60,
    )
    before_failure = datetime.now().astimezone()

    assert jobs.fail_claimed_job(
        jobs_pg_engine,
        job_id=job_id,
        attempts=attempts,
        error_message="x" * 5000,
    ) is True

    stored = _read_job(jobs_pg_engine, job_id)
    assert stored["status"] == expected_status
    assert stored["error_message"] == "x" * 4000
    if expected_delay_seconds is None:
        assert stored["lease_until"] is None
    else:
        delay = (stored["lease_until"] - before_failure).total_seconds()
        assert expected_delay_seconds - 2 <= delay <= expected_delay_seconds + 2


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 13, 12, 0, tzinfo=tz)


def test_process_sync_job(monkeypatch: pytest.MonkeyPatch) -> None:
    run_job = Mock(return_value={"inserted": 3})
    pg_engine = object()
    monkeypatch.setattr(jobs, "datetime", FrozenDateTime)
    monkeypatch.setattr(jobs, "run_job", run_job)

    result = jobs.process_sync_job(
        {},
        pg_engine,
        {"provider": jobs.PROVIDER_MANULIFE},
    )

    assert result == {"inserted": 3}
    run_job.assert_called_once_with(
        provider=jobs.PROVIDER_MANULIFE,
        from_date=date(2026, 10, 7),
        to_date=date(2026, 10, 13),
        pg_engine=pg_engine,
    )


@pytest.mark.parametrize("rolling_days", [0, 29])
def test_process_sync_job_rejects_invalid_rolling_days(rolling_days: int) -> None:
    with pytest.raises(ValueError, match="rolling_days must be between 1 and 28"):
        jobs.process_sync_job(
            {},
            object(),
            {"provider": jobs.PROVIDER_HSBC, "rolling_days": rolling_days},
        )


def test_process_backfill_job(monkeypatch: pytest.MonkeyPatch) -> None:
    run_job = Mock(return_value={"updated": 4})
    pg_engine = object()
    monkeypatch.setattr(jobs, "run_job", run_job)

    result = jobs.process_backfill_job(
        {},
        pg_engine,
        {
            "provider": jobs.PROVIDER_ALL,
            "from_date": "2026-01-01",
            "to_date": "2026-10-13",
        },
    )

    assert result == {"updated": 4}
    run_job.assert_called_once_with(
        provider=jobs.PROVIDER_ALL,
        from_date=date(2026, 1, 1),
        to_date=date(2026, 10, 13),
        pg_engine=pg_engine,
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"provider": "hsbc"},
        {"provider": "hsbc", "from_date": "invalid", "to_date": "2026-10-13"},
        {"provider": "hsbc", "from_date": "2026-10-14", "to_date": "2026-10-13"},
    ],
)
def test_process_backfill_job_rejects_invalid_ranges(payload: dict) -> None:
    with pytest.raises(ValueError):
        jobs.process_backfill_job({}, object(), payload)


def test_run_job_provider_hsbc(monkeypatch: pytest.MonkeyPatch) -> None:
    crawl_hsbc = Mock(return_value={"payload": "HSBC CSV"})
    parse_hsbc = Mock(return_value=["hsbc record"])
    save_hsbc = Mock(return_value={"inserted": 1, "updated": 0})
    crawl_manulife = Mock(side_effect=AssertionError("Manulife must not run"))
    save_manulife = Mock(side_effect=AssertionError("Manulife must not run"))
    monkeypatch.setattr(jobs, "crawl_hsbc", crawl_hsbc)
    monkeypatch.setattr(jobs, "parse_all_hsbc_funds_csv", parse_hsbc)
    monkeypatch.setattr(jobs, "save_hsbc_records", save_hsbc)
    monkeypatch.setattr(jobs, "crawl_manulife", crawl_manulife)
    monkeypatch.setattr(jobs, "save_manulife_records", save_manulife)
    pg_engine = object()

    result = jobs.run_job(
        provider=jobs.PROVIDER_HSBC,
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        pg_engine=pg_engine,
    )

    assert result == {"inserted": 1, "updated": 0}
    crawl_hsbc.assert_called_once_with(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
    )
    parse_hsbc.assert_called_once_with("HSBC CSV")
    save_hsbc.assert_called_once_with(pg_engine, ["hsbc record"])
    crawl_manulife.assert_not_called()
    save_manulife.assert_not_called()


def test_run_job_provider_manulife(monkeypatch: pytest.MonkeyPatch) -> None:
    crawl_hsbc = Mock(side_effect=AssertionError("HSBC must not run"))
    parse_hsbc = Mock(side_effect=AssertionError("HSBC must not run"))
    save_hsbc = Mock(side_effect=AssertionError("HSBC must not run"))
    crawl_manulife = Mock(
        return_value={
            "records": ["manulife record"],
            "funds_failed": [{"fund_id": "MANULIFE:SHK122"}],
        }
    )
    save_manulife = Mock(return_value={"inserted": 1, "updated": 0})
    monkeypatch.setattr(jobs, "crawl_hsbc", crawl_hsbc)
    monkeypatch.setattr(jobs, "parse_all_hsbc_funds_csv", parse_hsbc)
    monkeypatch.setattr(jobs, "save_hsbc_records", save_hsbc)
    monkeypatch.setattr(jobs, "crawl_manulife", crawl_manulife)
    monkeypatch.setattr(jobs, "save_manulife_records", save_manulife)
    pg_engine = object()

    result = jobs.run_job(
        provider=jobs.PROVIDER_MANULIFE,
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        pg_engine=pg_engine,
    )

    assert result == {
        "inserted": 1,
        "updated": 0,
        "funds_failed": [{"fund_id": "MANULIFE:SHK122"}],
    }
    crawl_manulife.assert_called_once_with(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
    )
    save_manulife.assert_called_once_with(pg_engine, ["manulife record"])
    crawl_hsbc.assert_not_called()
    parse_hsbc.assert_not_called()
    save_hsbc.assert_not_called()


def test_run_job_provider_all(monkeypatch: pytest.MonkeyPatch) -> None:
    crawl_hsbc = Mock(return_value={"payload": "HSBC CSV"})
    parse_hsbc = Mock(return_value=["hsbc record"])
    save_hsbc = Mock(return_value={"inserted": 2})
    crawl_manulife = Mock(
        return_value={"records": ["manulife record"], "funds_failed": []}
    )
    save_manulife = Mock(return_value={"inserted": 3})
    monkeypatch.setattr(jobs, "crawl_hsbc", crawl_hsbc)
    monkeypatch.setattr(jobs, "parse_all_hsbc_funds_csv", parse_hsbc)
    monkeypatch.setattr(jobs, "save_hsbc_records", save_hsbc)
    monkeypatch.setattr(jobs, "crawl_manulife", crawl_manulife)
    monkeypatch.setattr(jobs, "save_manulife_records", save_manulife)
    pg_engine = object()

    result = jobs.run_job(
        provider=jobs.PROVIDER_ALL,
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        pg_engine=pg_engine,
    )

    assert result == {
        "hsbc": {"inserted": 2},
        "manulife": {"inserted": 3, "funds_failed": []},
    }
    crawl_hsbc.assert_called_once()
    parse_hsbc.assert_called_once_with("HSBC CSV")
    save_hsbc.assert_called_once_with(pg_engine, ["hsbc record"])
    crawl_manulife.assert_called_once()
    save_manulife.assert_called_once_with(pg_engine, ["manulife record"])


def test_run_job_rejects_invalid_provider() -> None:
    with pytest.raises(ValueError, match="provider must be one of: all, hsbc, manulife"):
        jobs.run_job(
            provider="unknown",
            from_date=date(2026, 10, 1),
            to_date=date(2026, 10, 7),
            pg_engine=object(),
        )
