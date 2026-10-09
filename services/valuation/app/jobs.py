from __future__ import annotations

from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text

from shared.db import begin_connection
from services.valuation.app.calculations import calculate_portfolio_as_of, persist_snapshot


def build_job_handlers() -> dict[str, Any]:
    return {
        "snapshot": handle_snapshot_job,
        "rebuild": handle_rebuild_job,
    }


def handle_snapshot_job(payload: dict[str, Any]) -> dict[str, Any]:
    account_id = _parse_uuid(payload.get("account_id"))
    _apply_pending_invalidations(account_id=account_id)

    as_of_date = _parse_date(payload.get("as_of_date")) or datetime.utcnow().date()
    calculation = calculate_portfolio_as_of(
        as_of_date=as_of_date,
        account_id=account_id,
        include_estimated=True,
    )
    persist_result = persist_snapshot(calculation)
    return {
        "requested_as_of": calculation["requested_as_of"],
        "saved_accounts": persist_result["saved_accounts"],
        "calculation_status": calculation["calculation_status"],
        "unpriced_fund_count": calculation["unpriced_fund_count"],
    }


def handle_rebuild_job(payload: dict[str, Any]) -> dict[str, Any]:
    from_date = _parse_date(payload.get("from_date"))
    to_date = _parse_date(payload.get("to_date"))
    account_id = _parse_uuid(payload.get("account_id"))
    invalidations_applied = _apply_pending_invalidations(account_id=account_id)

    if from_date is None and to_date is None:
        dates = _list_stale_snapshot_dates(account_id=account_id)
    else:
        dates = _list_snapshot_dates_in_range(
            account_id=account_id,
            from_date=from_date,
            to_date=to_date,
        )

    rebuilt = 0
    for as_of_date in dates:
        calculation = calculate_portfolio_as_of(
            as_of_date=as_of_date,
            account_id=account_id,
            include_estimated=True,
        )
        persist_snapshot(calculation)
        rebuilt += 1

    return {
        "rebuilt_dates": [item.isoformat() for item in dates],
        "rebuilt_count": rebuilt,
        "invalidations_applied": invalidations_applied,
    }


def _list_stale_snapshot_dates(*, account_id: UUID | None) -> list[date]:
    params: dict[str, Any] = {}
    account_filter = ""
    if account_id is not None:
        account_filter = "AND account_id = :account_id"
        params["account_id"] = str(account_id)
    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT DISTINCT as_of_date
                FROM mpf.portfolio_snapshots
                WHERE stale = TRUE
                  {account_filter}
                ORDER BY as_of_date
                """.format(account_filter=account_filter)
            ),
            params,
        ).scalars().all()
    return list(rows)


def _list_snapshot_dates_in_range(
    *,
    account_id: UUID | None,
    from_date: date | None,
    to_date: date | None,
) -> list[date]:
    params: dict[str, Any] = {"from_date": from_date, "to_date": to_date}
    account_filter = ""
    if account_id is not None:
        account_filter = "AND account_id = :account_id"
        params["account_id"] = str(account_id)
    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT DISTINCT as_of_date
                FROM mpf.portfolio_snapshots
                WHERE (:from_date IS NULL OR as_of_date >= :from_date)
                  AND (:to_date IS NULL OR as_of_date <= :to_date)
                  {account_filter}
                ORDER BY as_of_date
                """.format(account_filter=account_filter)
            ),
            params,
        ).scalars().all()
    return list(rows)


def _parse_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def _parse_uuid(value: Any) -> UUID | None:
    if value in (None, ""):
        return None
    try:
        return UUID(str(value))
    except ValueError:
        return None


def _apply_pending_invalidations(*, account_id: UUID | None) -> int:
    params: dict[str, Any] = {}
    account_filter = ""
    if account_id is not None:
        account_filter = "AND account_id = :account_id"
        params["account_id"] = str(account_id)
    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT invalidation_id, account_id, from_date, to_date
                FROM mpf.snapshot_invalidation_requests
                WHERE processed_at IS NULL
                  {account_filter}
                ORDER BY created_at ASC
                FOR UPDATE SKIP LOCKED
                """.format(account_filter=account_filter)
            ),
            params,
        ).mappings().all()
        if not rows:
            return 0

        for row in rows:
            where_clauses = ["TRUE"]
            params: dict[str, Any] = {}
            if row["account_id"] is not None:
                where_clauses.append("account_id = :request_account_id")
                params["request_account_id"] = row["account_id"]
            if row["from_date"] is not None:
                where_clauses.append("as_of_date >= :from_date")
                params["from_date"] = row["from_date"]
            if row["to_date"] is not None:
                where_clauses.append("as_of_date <= :to_date")
                params["to_date"] = row["to_date"]
            connection.execute(
                text(
                    """
                    UPDATE mpf.portfolio_snapshots
                    SET stale = TRUE,
                        updated_at = NOW()
                    WHERE {where_clause}
                    """.format(where_clause=" AND ".join(where_clauses))
                ),
                params,
            )

        connection.execute(
            text(
                """
                UPDATE mpf.snapshot_invalidation_requests
                SET processed_at = NOW()
                WHERE invalidation_id = ANY(:ids)
                """
            ),
            {"ids": [str(row["invalidation_id"]) for row in rows]},
        )
    return len(rows)
