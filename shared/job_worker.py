from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

from shared.db import begin_connection
from shared.jobs import claim_next_job, complete_job, fail_job, heartbeat_job

LOGGER = logging.getLogger(__name__)


JobHandler = Callable[[dict[str, Any]], dict[str, Any]]


class JobWorker:
    def __init__(
        self,
        *,
        service: str,
        handlers: dict[str, JobHandler],
        poll_interval_seconds: float = 1.0,
        lease_seconds: int = 60,
    ) -> None:
        self._service = service
        self._handlers = handlers
        self._poll_interval_seconds = poll_interval_seconds
        self._lease_seconds = lease_seconds
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name=f"{self._service}-job-worker", daemon=True)
        self._thread.start()
        LOGGER.info("Started %s job worker", self._service)

    def stop(self, timeout_seconds: float = 10.0) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=timeout_seconds)
            self._thread = None
        LOGGER.info("Stopped %s job worker", self._service)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            claimed = False
            with begin_connection() as connection:
                job = claim_next_job(
                    connection,
                    service=self._service,
                    lease_seconds=self._lease_seconds,
                )
            if job:
                claimed = True
                self._process_job(job.job_id, job.job_type, job.request)

            if not claimed:
                self._stop_event.wait(self._poll_interval_seconds)

    def _process_job(self, job_id, job_type: str, request_payload: dict[str, Any]) -> None:
        handler = self._handlers.get(job_type)
        if handler is None:
            with begin_connection() as connection:
                fail_job(
                    connection,
                    job_id=job_id,
                    error_message=f"No handler registered for job_type={job_type}",
                )
            return

        try:
            with begin_connection() as connection:
                heartbeat_job(connection, job_id=job_id, lease_seconds=self._lease_seconds)
            result = handler(request_payload)
            with begin_connection() as connection:
                complete_job(connection, job_id=job_id, result_payload=result)
        except Exception as exc:  # explicit worker failure path
            LOGGER.exception("Job execution failed: %s (%s)", job_id, job_type)
            with begin_connection() as connection:
                fail_job(connection, job_id=job_id, error_message=str(exc))
            time.sleep(0.1)

