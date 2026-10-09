from __future__ import annotations

from datetime import date
from pathlib import Path
import sys


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs import invalidation  # type: ignore[import-not-found]


class _FakeConnection:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def execute(self, statement: object, params: dict[str, object]) -> None:
        self.calls.append({"statement": str(statement), "params": params})


def test_create_snapshot_invalidation_request_executes_expected_insert() -> None:
    connection = _FakeConnection()

    invalidation.create_snapshot_invalidation_request(
        connection,
        source_service="crawler",
        reason="crawler_sync",
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        account_id="123e4567-e89b-12d3-a456-426614174000",
    )

    assert len(connection.calls) == 1
    sql = connection.calls[0]["statement"]
    params = connection.calls[0]["params"]
    assert "INSERT INTO mpf.snapshot_invalidation_requests" in sql
    assert params == {
        "source_service": "crawler",
        "reason": "crawler_sync",
        "account_id": "123e4567-e89b-12d3-a456-426614174000",
        "from_date": date(2026, 10, 1),
        "to_date": date(2026, 10, 7),
    }
