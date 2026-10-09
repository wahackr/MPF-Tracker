from __future__ import annotations

import logging
import signal
import threading
import time
from typing import Callable

from .crawl_jobs import build_client, process_backfill_job, process_sync_job
from .db import begin_connection, ping_database
from .job_queue import (
    claim_next_crawler_job,
    complete_claimed_job,
    fail_claimed_job,
    heartbeat_claim,
)
from .settings import get_settings


LOGGER = logging.getLogger("crawler-worker")


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


def _build_handler_map(client) -> dict[str, Callable[[dict], dict]]:
    return {
        "sync": lambda payload: process_sync_job(payload, client),
        "backfill": lambda payload: process_backfill_job(payload, client),
    }


def main() -> None:
    _configure_logging()
    settings = get_settings()
    client = build_client()
    handlers = _build_handler_map(client)

    stop_event = threading.Event()

    def _stop_handler(signum, _frame) -> None:
        LOGGER.info("Received signal %s. Stopping crawler worker...", signum)
        stop_event.set()

    signal.signal(signal.SIGTERM, _stop_handler)
    signal.signal(signal.SIGINT, _stop_handler)

    if not ping_database():
        raise RuntimeError("Database is not reachable at startup")

    LOGGER.info(
        "Crawler worker started (poll=%ss lease=%ss heartbeat=%ss fixtures=%s)",
        settings.worker_poll_interval_seconds,
        settings.worker_lease_seconds,
        settings.worker_heartbeat_seconds,
        settings.crawler_use_fixtures,
    )

    while not stop_event.is_set():
        with begin_connection() as connection:
            claimed = claim_next_crawler_job(connection, lease_seconds=settings.worker_lease_seconds)

        if claimed is None:
            stop_event.wait(settings.worker_poll_interval_seconds)
            continue

        LOGGER.info("Claimed job %s type=%s attempt=%s", claimed.job_id, claimed.job_type, claimed.attempts)
        heartbeat_stop = threading.Event()

        def _heartbeat_loop() -> None:
            while not heartbeat_stop.wait(settings.worker_heartbeat_seconds):
                with begin_connection() as hb_conn:
                    still_owned = heartbeat_claim(
                        hb_conn,
                        job_id=claimed.job_id,
                        attempts=claimed.attempts,
                        lease_seconds=settings.worker_lease_seconds,
                    )
                if not still_owned:
                    LOGGER.warning("Lease ownership lost for job %s", claimed.job_id)
                    return

        heartbeat_thread = threading.Thread(target=_heartbeat_loop, name="crawler-job-heartbeat", daemon=True)
        heartbeat_thread.start()

        try:
            handler = handlers.get(claimed.job_type)
            if handler is None:
                raise ValueError(f"No handler registered for job_type={claimed.job_type}")
            result_payload = handler(claimed.request)
            with begin_connection() as connection:
                written = complete_claimed_job(
                    connection,
                    job_id=claimed.job_id,
                    attempts=claimed.attempts,
                    result_payload=result_payload,
                )
            if written:
                LOGGER.info("Completed job %s", claimed.job_id)
            else:
                LOGGER.warning("Skipped completion for stale claim on job %s", claimed.job_id)
        except Exception as exc:
            LOGGER.exception("Job %s failed", claimed.job_id)
            with begin_connection() as connection:
                written = fail_claimed_job(
                    connection,
                    job_id=claimed.job_id,
                    attempts=claimed.attempts,
                    error_message=str(exc),
                )
            if not written:
                LOGGER.warning("Skipped failure update for stale claim on job %s", claimed.job_id)
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=5.0)

    LOGGER.info("Crawler worker stopped")


if __name__ == "__main__":
    main()
