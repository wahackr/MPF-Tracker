from __future__ import annotations

import logging
import threading

from .libs.jobs import (
    claim_next_crawler_job,
    complete_claimed_job,
    fail_claimed_job,
    heartbeat_claim,
    process_backfill_job,
    process_sync_job,
)
from .libs.pgsql.main import get_engine

LOGGER = logging.getLogger("crawler-worker")

handlers = {
    "sync": process_sync_job,
    "backfill": process_backfill_job,
}


def process_next_job(config, pg_engine) -> bool:
    lease_seconds = int(config["WORKER_LEASE_SECONDS"])
    heartbeat_seconds = float(config["WORKER_HEARTBEAT_SECONDS"])
    claimed_job = claim_next_crawler_job(pg_engine, lease_seconds=lease_seconds)
    if claimed_job is None:
        return False

    job_id = claimed_job["job_id"]
    attempts = claimed_job["attempts"]
    heartbeat_stop = threading.Event()

    def heartbeat_loop() -> None:
        while not heartbeat_stop.wait(heartbeat_seconds):
            try:
                claim_is_owned = heartbeat_claim(
                    pg_engine,
                    job_id=job_id,
                    attempts=attempts,
                    lease_seconds=lease_seconds,
                )
            except Exception:
                LOGGER.exception("Heartbeat failed for job %s", job_id)
                return

            if not claim_is_owned:
                LOGGER.warning("Lease ownership lost for job %s", job_id)
                return

    heartbeat_thread = threading.Thread(
        target=heartbeat_loop,
        name="crawler-job-heartbeat",
        daemon=True,
    )
    heartbeat_thread.start()

    try:
        handler = handlers.get(claimed_job["job_type"])
        if handler is None:
            raise ValueError(
                f"No handler registered for job_type={claimed_job['job_type']}"
            )

        result_payload = handler(config, pg_engine, claimed_job["request"])
        written = complete_claimed_job(
            pg_engine,
            job_id=job_id,
            attempts=attempts,
            result_payload=result_payload,
        )
        if not written:
            LOGGER.warning("Skipped completion for stale claim on job %s", job_id)
    except Exception as exc:
        LOGGER.exception("Job %s failed", job_id)
        written = fail_claimed_job(
            pg_engine,
            job_id=job_id,
            attempts=attempts,
            error_message=str(exc),
        )
        if not written:
            LOGGER.warning("Skipped failure update for stale claim on job %s", job_id)
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=5.0)

    return True


def main(config, *, stop_event: threading.Event | None = None) -> None:
    pg_engine = get_engine(config)
    poll_interval_seconds = float(config["WORKER_POLL_INTERVAL_SECONDS"])
    worker_stop = stop_event or threading.Event()

    LOGGER.info("Crawler worker started")
    try:
        while not worker_stop.is_set():
            try:
                processed = process_next_job(config, pg_engine)
            except Exception:
                LOGGER.exception("Unable to claim or process crawler job")
                processed = False

            if not processed:
                worker_stop.wait(poll_interval_seconds)
    except KeyboardInterrupt:
        worker_stop.set()
    finally:
        pg_engine.dispose()
        LOGGER.info("Crawler worker stopped")
