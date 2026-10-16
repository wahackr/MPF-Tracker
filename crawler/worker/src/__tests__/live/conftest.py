from __future__ import annotations

import sys
from pathlib import Path

import pytest


WORKER_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))


@pytest.fixture
def live_fetch_options() -> dict[str, object]:
    return {
        "timeout_seconds": 45.0,
        "retries": 3,
        "backoff_seconds": 1.5,
    }
