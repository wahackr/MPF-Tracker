from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Mapping, Protocol
from uuid import UUID

from .libs.job_queue import ClaimedJob

LOGGER = logging.getLogger("crawler-worker")
JobHandler = Callable[[dict[str, Any]], dict[str, Any]]


class JobStore(Protocol):
    def claim(self, lease_seconds: int) -> ClaimedJob | None: ...

    def heartbeat(self, job_id: UUID, attempts: int, lease_seconds: int) -> bool: ...

    def complete(self, job_id: UUID, attempts: int, result_payload: dict[str, Any]) -> bool: ...

    def fail(self, job_id: UUID, attempts: int, error_message: str) -> bool: ...


class CrawlerWorker:
    def __init__(
        self,
        store: JobStore,
        handlers: Mapping[str, JobHandler],
        *,
        poll_interval_seconds: float,
        lease_seconds: int,
        heartbeat_seconds: float,
    ) -> None:
        self.store = store
        self.handlers = handlers
        self.poll_interval_seconds = poll_interval_seconds
        self.lease_seconds = lease_seconds
        self.heartbeat_seconds = heartbeat_seconds
        self.stop_event = threading.Event()

    def stop(self) -> None:
        self.stop_event.set()

    def run_once(self) -> bool:
        claimed = self.store.claim(self.lease_seconds)
        if claimed is None:
            return False

        job_id = claimed["job_id"]
        attempts = claimed["attempts"]
        LOGGER.info("Claimed job %s type=%s attempt=%s", job_id, claimed["job_type"], attempts)
        heartbeat_stop = threading.Event()

        def heartbeat_loop() -> None:
            while not heartbeat_stop.wait(self.heartbeat_seconds):
                try:
                    owned = self.store.heartbeat(job_id, attempts, self.lease_seconds)
                except Exception:
                    LOGGER.exception("Heartbeat failed for job %s", job_id)
                    return
                if not owned:
                    LOGGER.warning("Lease ownership lost for job %s", job_id)
                    return

        heartbeat_thread = threading.Thread(
            target=heartbeat_loop, name="crawler-job-heartbeat", daemon=True
        )
        heartbeat_thread.start()
        try:
            handler = self.handlers.get(claimed["job_type"])
            if handler is None:
                raise ValueError(f"No handler registered for job_type={claimed['job_type']}")
            result_payload = handler(claimed["request"])
            written = self.store.complete(job_id, attempts, result_payload)
            if written:
                LOGGER.info("Completed job %s", job_id)
            else:
                LOGGER.warning("Skipped completion for stale claim on job %s", job_id)
        except Exception as exc:
            LOGGER.exception("Job %s failed", job_id)
            written = self.store.fail(job_id, attempts, str(exc))
            if not written:
                LOGGER.warning("Skipped failure update for stale claim on job %s", job_id)
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=5.0)
        return True

    def run_forever(self) -> None:
        while not self.stop_event.is_set():
            if not self.run_once():
                self.stop_event.wait(self.poll_interval_seconds)
