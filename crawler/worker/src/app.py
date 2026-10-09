from __future__ import annotations

import logging
import signal

from .libs.db import ping_database
from .libs.job_store import DatabaseJobStore
from .libs.settings import get_settings
from .main import process_backfill_job, process_sync_job
from .worker_runtime import CrawlerWorker

LOGGER = logging.getLogger("crawler-worker")


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


def main() -> None:
    _configure_logging()
    settings = get_settings()
    worker = CrawlerWorker(
        DatabaseJobStore(),
        {"sync": process_sync_job, "backfill": process_backfill_job},
        poll_interval_seconds=settings.worker_poll_interval_seconds,
        lease_seconds=settings.worker_lease_seconds,
        heartbeat_seconds=settings.worker_heartbeat_seconds,
    )

    def stop_handler(signum, _frame) -> None:
        LOGGER.info("Received signal %s. Stopping crawler worker...", signum)
        worker.stop()

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)

    if not ping_database():
        raise RuntimeError("Database is not reachable at startup")

    LOGGER.info(
        "Crawler worker started (poll=%ss lease=%ss heartbeat=%ss fixtures=%s)",
        settings.worker_poll_interval_seconds,
        settings.worker_lease_seconds,
        settings.worker_heartbeat_seconds,
        settings.crawler_use_fixtures,
    )
    worker.run_forever()
    LOGGER.info("Crawler worker stopped")


if __name__ == "__main__":
    main()
