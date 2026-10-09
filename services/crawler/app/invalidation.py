from __future__ import annotations

from datetime import date

from sqlalchemy import text
from sqlalchemy.engine import Connection


def create_snapshot_invalidation_request(
    connection: Connection,
    *,
    source_service: str,
    reason: str,
    from_date: date | None = None,
    to_date: date | None = None,
    account_id: str | None = None,
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO mpf.snapshot_invalidation_requests (
                source_service, reason, account_id, from_date, to_date
            )
            VALUES (
                :source_service, :reason, CAST(:account_id AS UUID), :from_date, :to_date
            )
            """
        ),
        {
            "source_service": source_service,
            "reason": reason,
            "account_id": account_id,
            "from_date": from_date,
            "to_date": to_date,
        },
    )
