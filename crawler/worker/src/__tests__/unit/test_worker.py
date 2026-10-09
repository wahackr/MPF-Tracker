from __future__ import annotations

from pathlib import Path
import sys
from threading import Event
from typing import Any
from uuid import UUID, uuid4

import pytest


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs.job_queue import ClaimedJob  # type: ignore[import-not-found]
from src import app  # type: ignore[import-not-found]
from src.worker_runtime import CrawlerWorker  # type: ignore[import-not-found]


class FakeJobStore:
    """One in-memory boundary for the database-backed job queue."""

    def __init__(self, *jobs: ClaimedJob) -> None:
        self.pending = list(jobs)
        self.outcomes: list[tuple[str, UUID, int, Any]] = []
        self.heartbeat_seen = Event()

    def claim(self, lease_seconds: int) -> ClaimedJob | None:
        return self.pending.pop(0) if self.pending else None

    def heartbeat(self, job_id: UUID, attempts: int, lease_seconds: int) -> bool:
        self.heartbeat_seen.set()
        return True

    def complete(self, job_id: UUID, attempts: int, result_payload: dict[str, Any]) -> bool:
        self.outcomes.append(("completed", job_id, attempts, result_payload))
        return True

    def fail(self, job_id: UUID, attempts: int, error_message: str) -> bool:
        self.outcomes.append(("failed", job_id, attempts, error_message))
        return True


def claimed_job(job_type: str = "sync", attempts: int = 1) -> ClaimedJob:
    return {
        "job_id": uuid4(),
        "job_type": job_type,
        "request": {"provider": "hsbc"},
        "attempts": attempts,
        "lease_until": None,
    }


def worker(store: FakeJobStore, handlers: dict[str, Any], heartbeat_seconds: float = 15) -> CrawlerWorker:
    return CrawlerWorker(
        store,
        handlers,
        poll_interval_seconds=0.01,
        lease_seconds=90,
        heartbeat_seconds=heartbeat_seconds,
    )


def test_idle_worker_does_not_call_handler() -> None:
    store = FakeJobStore()

    assert worker(store, {"sync": lambda _: 1}).run_once() is False
    assert store.outcomes == []


def test_worker_passes_request_to_handler_and_records_result() -> None:
    job = claimed_job()
    store = FakeJobStore(job)
    requests: list[dict[str, Any]] = []

    def handle(request: dict[str, Any]) -> dict[str, Any]:
        requests.append(request)
        return {"funds_updated": 3}

    assert worker(store, {"sync": handle}).run_once() is True
    assert requests == [job["request"]]
    assert store.outcomes == [("completed", job["job_id"], 1, {"funds_updated": 3})]


def test_worker_records_handler_failure_for_retry() -> None:
    job = claimed_job(attempts=2)
    store = FakeJobStore(job)

    def fail(_request: dict[str, Any]) -> dict[str, Any]:
        raise ValueError("provider unavailable")

    assert worker(store, {"sync": fail}).run_once() is True
    assert store.outcomes == [("failed", job["job_id"], 2, "provider unavailable")]


def test_worker_rejects_unknown_job_type() -> None:
    job = claimed_job(job_type="unknown")
    store = FakeJobStore(job)

    assert worker(store, {}).run_once() is True
    assert store.outcomes == [
        ("failed", job["job_id"], 1, "No handler registered for job_type=unknown")
    ]


def test_worker_renews_lease_while_handler_is_running() -> None:
    job = claimed_job()
    store = FakeJobStore(job)

    def handle(_request: dict[str, Any]) -> dict[str, Any]:
        assert store.heartbeat_seen.wait(timeout=1)
        return {"ok": True}

    assert worker(store, {"sync": handle}, heartbeat_seconds=0.001).run_once() is True
    assert store.heartbeat_seen.is_set()
    assert store.outcomes == [("completed", job["job_id"], 1, {"ok": True})]


def test_app_fails_fast_when_database_is_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app, "ping_database", lambda: False)
    monkeypatch.setattr(app.signal, "signal", lambda *_args: None)

    with pytest.raises(RuntimeError, match="Database is not reachable at startup"):
        app.main()
