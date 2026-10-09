from __future__ import annotations

from pathlib import Path
import sys

import pytest


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src import main as crawl_jobs  # type: ignore[import-not-found]


def test_sync_job_requires_provider_field() -> None:
    with pytest.raises(KeyError, match="provider"):
        crawl_jobs.process_sync_job({})


def test_backfill_job_requires_provider_field() -> None:
    with pytest.raises(KeyError, match="provider"):
        crawl_jobs.process_backfill_job({"from_date": "2026-10-01", "to_date": "2026-10-02"})


def test_sync_rejects_invalid_provider() -> None:
    with pytest.raises(ValueError, match="provider must be one of"):
        crawl_jobs.process_sync_job({"provider": "bad-provider"})


def test_backfill_rejects_invalid_provider() -> None:
    with pytest.raises(ValueError, match="provider must be one of"):
        crawl_jobs.process_backfill_job(
            {"provider": "bad-provider", "from_date": "2026-10-01", "to_date": "2026-10-02"}
        )
