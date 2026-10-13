from __future__ import annotations

from pathlib import Path
import sys
from threading import Event
from uuid import uuid4


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src import app
from src import main as worker_main


CONFIG = {
    "WORKER_POLL_INTERVAL_SECONDS": 0.001,
    "WORKER_LEASE_SECONDS": 90,
    "WORKER_HEARTBEAT_SECONDS": 0.001,
}


def claimed_job(job_type: str = "sync", attempts: int = 1):
    return {
        "job_id": uuid4(),
        "job_type": job_type,
        "request": {"provider": "hsbc"},
        "attempts": attempts,
        "lease_until": None,
    }


def test_process_next_job_returns_false_when_queue_is_empty(monkeypatch) -> None:
    monkeypatch.setattr(worker_main, "claim_next_crawler_job", lambda *_args, **_kwargs: None)

    assert worker_main.process_next_job(CONFIG, object()) is False


def test_process_next_job_completes_successful_claim(monkeypatch) -> None:
    job = claimed_job()
    calls: list[tuple] = []
    monkeypatch.setattr(worker_main, "claim_next_crawler_job", lambda *_args, **_kwargs: job)
    monkeypatch.setitem(
        worker_main.handlers,
        "sync",
        lambda config, engine, request: calls.append(
            ("handled", config, engine, request)
        )
        or {"inserted": 2},
    )
    monkeypatch.setattr(
        worker_main,
        "complete_claimed_job",
        lambda engine, **kwargs: calls.append(("completed", engine, kwargs)) or True,
    )
    monkeypatch.setattr(
        worker_main,
        "fail_claimed_job",
        lambda *_args, **_kwargs: calls.append(("failed",)) or True,
    )
    engine = object()

    assert worker_main.process_next_job(CONFIG, engine) is True
    assert calls[0] == ("handled", CONFIG, engine, job["request"])
    assert calls[1] == (
        "completed",
        engine,
        {
            "job_id": job["job_id"],
            "attempts": 1,
            "result_payload": {"inserted": 2},
        },
    )
    assert all(call[0] != "failed" for call in calls)


def test_process_next_job_records_handler_failure(monkeypatch) -> None:
    job = claimed_job(attempts=2)
    failures: list[dict] = []
    monkeypatch.setattr(worker_main, "claim_next_crawler_job", lambda *_args, **_kwargs: job)

    def broken_handler(_config, _engine, _request):
        raise ValueError("provider unavailable")

    monkeypatch.setitem(worker_main.handlers, "sync", broken_handler)
    monkeypatch.setattr(
        worker_main,
        "complete_claimed_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("completion must not run")
        ),
    )
    monkeypatch.setattr(
        worker_main,
        "fail_claimed_job",
        lambda _engine, **kwargs: failures.append(kwargs) or True,
    )

    assert worker_main.process_next_job(CONFIG, object()) is True
    assert failures == [
        {
            "job_id": job["job_id"],
            "attempts": 2,
            "error_message": "provider unavailable",
        }
    ]


def test_process_next_job_heartbeats_during_long_handler(monkeypatch) -> None:
    job = claimed_job()
    heartbeat_seen = Event()
    monkeypatch.setattr(worker_main, "claim_next_crawler_job", lambda *_args, **_kwargs: job)
    monkeypatch.setattr(
        worker_main,
        "heartbeat_claim",
        lambda *_args, **_kwargs: heartbeat_seen.set() or True,
    )

    def wait_for_heartbeat(_config, _engine, _request):
        assert heartbeat_seen.wait(timeout=1)
        return {"inserted": 1}

    monkeypatch.setitem(worker_main.handlers, "sync", wait_for_heartbeat)
    monkeypatch.setattr(worker_main, "complete_claimed_job", lambda *_args, **_kwargs: True)

    assert worker_main.process_next_job(CONFIG, object()) is True
    assert heartbeat_seen.is_set()


def test_main_polls_until_stop_and_disposes_engine(monkeypatch) -> None:
    stop = Event()

    class FakeEngine:
        disposed = False

        def dispose(self):
            self.disposed = True

    engine = FakeEngine()
    monkeypatch.setattr(worker_main, "get_engine", lambda _config: engine)

    def process_once(_config, _engine):
        stop.set()
        return True

    monkeypatch.setattr(worker_main, "process_next_job", process_once)

    worker_main.main(CONFIG, stop_event=stop)

    assert engine.disposed is True


def test_app_builds_typed_configuration() -> None:
    assert isinstance(app.config, dict)
    assert isinstance(app.config["PGSQL_PORT"], int)
    assert isinstance(app.config["WORKER_POLL_INTERVAL_SECONDS"], float)
    assert isinstance(app.config["WORKER_LEASE_SECONDS"], int)
    assert isinstance(app.config["WORKER_HEARTBEAT_SECONDS"], float)


def test_app_healthcheck_disposes_engine(monkeypatch) -> None:
    class FakeEngine:
        disposed = False

        def dispose(self):
            self.disposed = True

    engine = FakeEngine()
    monkeypatch.setattr(app, "get_engine", lambda _config: engine)
    monkeypatch.setattr(app, "ping_database", lambda received: received is engine)

    assert app.healthcheck() is True
    assert engine.disposed is True
