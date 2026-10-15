from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest


WORKER_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))


@pytest.fixture(autouse=True)
def require_live_opt_in() -> None:
    enabled = os.getenv("MPF_RUN_LIVE_TESTS", "").strip().lower() in {"1", "true", "yes", "on"}
    if not enabled:
        pytest.skip("Set MPF_RUN_LIVE_TESTS=1 to run live crawler smoke tests")


@pytest.fixture
def live_fetch_options() -> dict[str, object]:
    return {
        "timeout_seconds": 45.0,
        "retries": 3,
        "backoff_seconds": 1.5,
    }
