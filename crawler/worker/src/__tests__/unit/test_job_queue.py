from __future__ import annotations

import json
from pathlib import Path
import sys
from types import SimpleNamespace
from uuid import uuid4


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs import job_queue  # type: ignore[import-not-found]


class _FakeExecuteResult:
    def __init__(self, *, row: dict | None = None, rowcount: int = 0) -> None:
        self._row = row
        self.rowcount = rowcount

    def mappings(self) -> SimpleNamespace:
        return SimpleNamespace(first=lambda: self._row)


class _FakeConnection:
    def __init__(self, outputs: list[_FakeExecuteResult]) -> None:
        self._outputs = list(outputs)
        self.calls: list[dict[str, object]] = []

    def execute(self, statement: object, params: dict[str, object]) -> _FakeExecuteResult:
        self.calls.append({"statement": str(statement), "params": params})
        return self._outputs.pop(0)


def test_claim_next_crawler_job_returns_none_when_no_candidate() -> None:
    connection = _FakeConnection([_FakeExecuteResult(row=None)])
    claimed = job_queue.claim_next_crawler_job(connection, lease_seconds=90)
    assert claimed is None
    assert connection.calls[0]["params"] == {"lease_seconds": 90, "max_attempts": 3}


def test_claim_next_crawler_job_maps_row_fields() -> None:
    job_id = uuid4()
    row = {
        "job_id": job_id,
        "job_type": "sync",
        "request": {"provider": "all", "rolling_days": 7},
        "attempts": "3",
        "lease_until": "2026-10-09T00:00:00Z",
    }
    connection = _FakeConnection([_FakeExecuteResult(row=row)])

    claimed = job_queue.claim_next_crawler_job(connection, lease_seconds=45)

    assert claimed is not None
    assert claimed["job_id"] == job_id
    assert claimed["job_type"] == "sync"
    assert claimed["request"] == {"provider": "all", "rolling_days": 7}
    assert claimed["attempts"] == 3
    assert claimed["lease_until"] == "2026-10-09T00:00:00Z"


def test_heartbeat_claim_reflects_rowcount() -> None:
    job_id = uuid4()
    ok_connection = _FakeConnection([_FakeExecuteResult(rowcount=1)])
    stale_connection = _FakeConnection([_FakeExecuteResult(rowcount=0)])

    assert job_queue.heartbeat_claim(ok_connection, job_id=job_id, attempts=2, lease_seconds=90) is True
    assert job_queue.heartbeat_claim(stale_connection, job_id=job_id, attempts=2, lease_seconds=90) is False

    assert ok_connection.calls[0]["params"] == {
        "job_id": str(job_id),
        "attempts": 2,
        "lease_seconds": 90,
    }


def test_complete_claimed_job_serializes_result_payload_and_reflects_rowcount() -> None:
    job_id = uuid4()
    payload = {"providers": ["hsbc"], "price_rows_inserted": 1}
    ok_connection = _FakeConnection([_FakeExecuteResult(rowcount=1)])
    stale_connection = _FakeConnection([_FakeExecuteResult(rowcount=0)])

    assert job_queue.complete_claimed_job(
        ok_connection,
        job_id=job_id,
        attempts=4,
        result_payload=payload,
    ) is True
    assert job_queue.complete_claimed_job(
        stale_connection,
        job_id=job_id,
        attempts=4,
        result_payload=payload,
    ) is False

    params = ok_connection.calls[0]["params"]
    assert params["job_id"] == str(job_id)
    assert params["attempts"] == 4
    assert json.loads(str(params["result"])) == payload


def test_complete_claimed_job_marks_per_fund_failures_partial() -> None:
    connection = _FakeConnection([_FakeExecuteResult(rowcount=1)])
    job_queue.complete_claimed_job(
        connection,
        job_id=uuid4(),
        attempts=1,
        result_payload={"funds_failed": [{"fund_id": "manulife:A", "error": "blocked"}]},
    )
    assert connection.calls[0]["params"]["status"] == "partial"


def test_failure_requeues_only_below_attempt_limit() -> None:
    retry = _FakeConnection([_FakeExecuteResult(rowcount=1)])
    exhausted = _FakeConnection([_FakeExecuteResult(rowcount=1)])
    job_queue.fail_claimed_job(retry, job_id=uuid4(), attempts=1, error_message="timeout")
    job_queue.fail_claimed_job(exhausted, job_id=uuid4(), attempts=3, error_message="timeout")
    assert retry.calls[0]["params"]["status"] == "queued"
    assert exhausted.calls[0]["params"]["status"] == "failed"
    assert retry.calls[0]["params"]["retry_delay_seconds"] == 30


def test_fail_claimed_job_truncates_error_message() -> None:
    job_id = uuid4()
    long_error = "x" * 5000
    connection = _FakeConnection([_FakeExecuteResult(rowcount=1)])

    written = job_queue.fail_claimed_job(connection, job_id=job_id, attempts=1, error_message=long_error)

    assert written is True
    params = connection.calls[0]["params"]
    assert params["job_id"] == str(job_id)
    assert params["attempts"] == 1
    assert isinstance(params["error_message"], str)
    assert len(params["error_message"]) == 4000
