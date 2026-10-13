from __future__ import annotations

from contextlib import contextmanager
from datetime import date
import json
from pathlib import Path
import sys
from uuid import uuid4


WORKER_SRC_DIR = Path(__file__).resolve().parents[2]
if str(WORKER_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC_DIR))

from libs import jobs


class FakeResult:
    def __init__(self, rowcount: int) -> None:
        self.rowcount = rowcount


class FakeClaimResult:
    def __init__(self, row) -> None:
        self.row = row

    def mappings(self):
        return self

    def first(self):
        return self.row


class FakeConnection:
    def __init__(self, rowcount: int = 1) -> None:
        self.rowcount = rowcount
        self.calls: list[dict[str, object]] = []

    def execute(self, statement, params):
        self.calls.append({"statement": str(statement), "params": params})
        return FakeResult(self.rowcount)


class FakeClaimConnection:
    def __init__(self, row) -> None:
        self.row = row
        self.calls: list[dict[str, object]] = []

    def execute(self, statement, params):
        self.calls.append({"statement": str(statement), "params": params})
        return FakeClaimResult(self.row)


class FakeEngine:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection
        self.transactions = 0

    @contextmanager
    def begin(self):
        self.transactions += 1
        yield self.connection


def test_claim_next_crawler_job_returns_none_when_queue_is_empty() -> None:
    connection = FakeClaimConnection(None)

    claimed = jobs.claim_next_crawler_job(FakeEngine(connection), lease_seconds=90)

    assert claimed is None
    assert connection.calls[0]["params"] == {
        "lease_seconds": 90,
        "max_attempts": jobs.MAX_ATTEMPTS,
    }


def test_claim_next_crawler_job_returns_claim_data() -> None:
    job_id = uuid4()
    connection = FakeClaimConnection(
        {
            "job_id": job_id,
            "job_type": "backfill",
            "request": {
                "provider": "hsbc",
                "from_date": "2026-09-01",
                "to_date": "2026-10-07",
            },
            "attempts": "2",
            "lease_until": "2026-10-13T12:00:00Z",
        }
    )

    claimed = jobs.claim_next_crawler_job(FakeEngine(connection), lease_seconds=60)

    assert claimed == {
        "job_id": job_id,
        "job_type": "backfill",
        "request": {
            "provider": "hsbc",
            "from_date": "2026-09-01",
            "to_date": "2026-10-07",
        },
        "attempts": 2,
        "lease_until": "2026-10-13T12:00:00Z",
    }


def test_complete_claimed_job_serializes_dates_and_marks_success() -> None:
    job_id = uuid4()
    connection = FakeConnection()
    engine = FakeEngine(connection)

    written = jobs.complete_claimed_job(
        engine,
        job_id=job_id,
        attempts=2,
        result_payload={
            "inserted": 3,
            "min_changed_date": date(2026, 10, 1),
            "funds_failed": [],
        },
    )

    assert written is True
    assert engine.transactions == 1
    params = connection.calls[0]["params"]
    assert params["job_id"] == str(job_id)
    assert params["attempts"] == 2
    assert params["status"] == "succeeded"
    assert json.loads(params["result"])["min_changed_date"] == "2026-10-01"


def test_heartbeat_claim_extends_an_owned_lease() -> None:
    job_id = uuid4()
    connection = FakeConnection()

    owned = jobs.heartbeat_claim(
        FakeEngine(connection),
        job_id=job_id,
        attempts=2,
        lease_seconds=90,
    )

    assert owned is True
    assert connection.calls[0]["params"] == {
        "job_id": str(job_id),
        "attempts": 2,
        "lease_seconds": 90,
    }


def test_complete_claimed_job_detects_nested_provider_failures() -> None:
    connection = FakeConnection(rowcount=0)

    written = jobs.complete_claimed_job(
        FakeEngine(connection),
        job_id=uuid4(),
        attempts=1,
        result_payload={
            "hsbc": {"inserted": 1},
            "manulife": {"funds_failed": [{"fund_id": "MANULIFE:SHK122"}]},
        },
    )

    assert written is False
    assert connection.calls[0]["params"]["status"] == "partial"


def test_fail_claimed_job_requeues_before_attempt_limit() -> None:
    connection = FakeConnection()

    written = jobs.fail_claimed_job(
        FakeEngine(connection),
        job_id=uuid4(),
        attempts=2,
        error_message="provider unavailable",
    )

    assert written is True
    params = connection.calls[0]["params"]
    assert params["status"] == "queued"
    assert params["retry_delay_seconds"] == 60
    assert params["error_message"] == "provider unavailable"


def test_fail_claimed_job_stops_retrying_and_truncates_error() -> None:
    connection = FakeConnection(rowcount=0)

    written = jobs.fail_claimed_job(
        FakeEngine(connection),
        job_id=uuid4(),
        attempts=jobs.MAX_ATTEMPTS,
        error_message="x" * 5000,
    )

    assert written is False
    params = connection.calls[0]["params"]
    assert params["status"] == "failed"
    assert len(params["error_message"]) == 4000
