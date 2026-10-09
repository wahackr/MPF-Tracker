from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from sqlalchemy import text

from shared.db import begin_connection
from services.portfolio.app.invalidation import create_snapshot_invalidation_request


def build_job_handlers() -> dict[str, Any]:
    return {
        "record-baseline": handle_record_baseline,
        "publish-allocation-rules": handle_publish_allocation_rules,
        "set-contribution-plan": handle_set_contribution_plan,
        "reconcile-holdings": handle_reconcile_holdings,
    }


def handle_record_baseline(payload: dict[str, Any]) -> dict[str, Any]:
    account_id = _parse_uuid(payload.get("account_id"), "account_id")
    effective_date = _parse_date(payload.get("effective_date"), "effective_date")
    source = _require_str(payload.get("source"), "source")
    verification_status = _require_str(payload.get("verification_status"), "verification_status").upper()
    if verification_status not in {"VERIFIED", "ESTIMATED"}:
        raise ValueError("verification_status must be VERIFIED or ESTIMATED")
    holdings = _require_list(payload.get("holdings"), "holdings")

    inserted = 0
    with begin_connection() as connection:
        _ensure_account_exists(connection, account_id)
        for item in holdings:
            fund_id = _require_str(item.get("fund_id"), "holdings[].fund_id")
            units = _parse_decimal(item.get("units"), "holdings[].units")
            _ensure_fund_exists(connection, fund_id)
            connection.execute(
                text(
                    """
                    INSERT INTO mpf.holdings_baselines (
                        account_id, fund_id, effective_date, units, source, verification_status
                    )
                    VALUES (
                        :account_id, :fund_id, :effective_date, :units, :source, :verification_status
                    )
                    """
                ),
                {
                    "account_id": str(account_id),
                    "fund_id": fund_id,
                    "effective_date": effective_date,
                    "units": units,
                    "source": source,
                    "verification_status": verification_status,
                },
            )
            inserted += 1

        create_snapshot_invalidation_request(
            connection,
            source_service="portfolio",
            reason="baseline_update",
            from_date=effective_date,
            account_id=str(account_id),
        )

    return {"account_id": str(account_id), "inserted_baselines": inserted}


def handle_publish_allocation_rules(payload: dict[str, Any]) -> dict[str, Any]:
    account_id = _parse_uuid(payload.get("account_id"), "account_id")
    contribution_stream = _require_str(payload.get("contribution_stream"), "contribution_stream").lower()
    effective_from = _parse_date(payload.get("effective_from"), "effective_from")
    effective_to = _optional_date(payload.get("effective_to"))
    allocations = _require_list(payload.get("allocations"), "allocations")

    total_weight = Decimal("0")
    parsed_allocations: list[tuple[str, Decimal]] = []
    for item in allocations:
        fund_id = _require_str(item.get("fund_id"), "allocations[].fund_id")
        weight = _parse_decimal(item.get("weight"), "allocations[].weight")
        if weight < 0:
            raise ValueError("allocations[].weight must be >= 0")
        parsed_allocations.append((fund_id, weight))
        total_weight += weight
    if total_weight != Decimal("100"):
        raise ValueError("allocation weights must sum to exactly 100")

    with begin_connection() as connection:
        _ensure_account_exists(connection, account_id)
        close_date = effective_from - timedelta(days=1)
        connection.execute(
            text(
                """
                UPDATE mpf.allocation_rules
                SET effective_to = :close_date,
                    updated_at = NOW()
                WHERE account_id = :account_id
                  AND contribution_stream = :contribution_stream
                  AND (effective_to IS NULL OR effective_to >= :effective_from)
                """
            ),
            {
                "account_id": str(account_id),
                "contribution_stream": contribution_stream,
                "close_date": close_date,
                "effective_from": effective_from,
            },
        )

        for fund_id, weight in parsed_allocations:
            _ensure_fund_exists(connection, fund_id)
            connection.execute(
                text(
                    """
                    INSERT INTO mpf.allocation_rules (
                        account_id, fund_id, contribution_stream, effective_from, effective_to, weight
                    )
                    VALUES (
                        :account_id, :fund_id, :contribution_stream, :effective_from, :effective_to, :weight
                    )
                    """
                ),
                {
                    "account_id": str(account_id),
                    "fund_id": fund_id,
                    "contribution_stream": contribution_stream,
                    "effective_from": effective_from,
                    "effective_to": effective_to,
                    "weight": weight,
                },
            )

    return {
        "account_id": str(account_id),
        "contribution_stream": contribution_stream,
        "effective_from": effective_from.isoformat(),
        "allocation_count": len(parsed_allocations),
    }


def handle_set_contribution_plan(payload: dict[str, Any]) -> dict[str, Any]:
    account_id = _parse_uuid(payload.get("account_id"), "account_id")
    contribution_stream = _require_str(payload.get("contribution_stream"), "contribution_stream").lower()
    amount = _parse_decimal(payload.get("amount"), "amount")
    expected_day = int(payload.get("expected_day"))
    effective_from = _parse_date(payload.get("effective_from"), "effective_from")
    effective_to = _optional_date(payload.get("effective_to"))
    if expected_day < 1 or expected_day > 31:
        raise ValueError("expected_day must be in range 1..31")
    if amount <= 0:
        raise ValueError("amount must be > 0")

    with begin_connection() as connection:
        _ensure_account_exists(connection, account_id)
        connection.execute(
            text(
                """
                UPDATE mpf.contribution_plans
                SET active = FALSE,
                    effective_to = :closed_to,
                    updated_at = NOW()
                WHERE account_id = :account_id
                  AND contribution_stream = :contribution_stream
                  AND active = TRUE
                """
            ),
            {
                "closed_to": effective_from - timedelta(days=1),
                "account_id": str(account_id),
                "contribution_stream": contribution_stream,
            },
        )

        row = connection.execute(
            text(
                """
                INSERT INTO mpf.contribution_plans (
                    account_id, contribution_stream, amount, expected_day,
                    effective_from, effective_to, active
                )
                VALUES (
                    :account_id, :contribution_stream, :amount, :expected_day,
                    :effective_from, :effective_to, TRUE
                )
                RETURNING plan_id
                """
            ),
            {
                "account_id": str(account_id),
                "contribution_stream": contribution_stream,
                "amount": amount,
                "expected_day": expected_day,
                "effective_from": effective_from,
                "effective_to": effective_to,
            },
        ).mappings().one()

    return {
        "plan_id": str(row["plan_id"]),
        "account_id": str(account_id),
        "contribution_stream": contribution_stream,
    }


def handle_reconcile_holdings(payload: dict[str, Any]) -> dict[str, Any]:
    account_id = _parse_uuid(payload.get("account_id"), "account_id")
    effective_date = _parse_date(payload.get("effective_date"), "effective_date")
    notes = payload.get("notes")
    holdings = _require_list(payload.get("holdings"), "holdings")
    inserted = 0

    with begin_connection() as connection:
        _ensure_account_exists(connection, account_id)
        connection.execute(
            text(
                """
                INSERT INTO mpf.reconciliation_records (account_id, effective_date, notes)
                VALUES (:account_id, :effective_date, :notes)
                """
            ),
            {
                "account_id": str(account_id),
                "effective_date": effective_date,
                "notes": notes,
            },
        )
        for item in holdings:
            fund_id = _require_str(item.get("fund_id"), "holdings[].fund_id")
            units = _parse_decimal(item.get("units"), "holdings[].units")
            _ensure_fund_exists(connection, fund_id)
            connection.execute(
                text(
                    """
                    INSERT INTO mpf.holdings_baselines (
                        account_id, fund_id, effective_date, units, source, verification_status
                    )
                    VALUES (
                        :account_id, :fund_id, :effective_date, :units, 'reconciliation', 'VERIFIED'
                    )
                    """
                ),
                {
                    "account_id": str(account_id),
                    "fund_id": fund_id,
                    "effective_date": effective_date,
                    "units": units,
                },
            )
            inserted += 1

        create_snapshot_invalidation_request(
            connection,
            source_service="portfolio",
            reason="reconciliation",
            from_date=effective_date,
            account_id=str(account_id),
        )

    return {
        "account_id": str(account_id),
        "effective_date": effective_date.isoformat(),
        "inserted_baselines": inserted,
    }


def _ensure_account_exists(connection, account_id: UUID) -> None:
    exists = connection.execute(
        text("SELECT 1 FROM mpf.accounts WHERE account_id = :account_id"),
        {"account_id": str(account_id)},
    ).first()
    if not exists:
        raise ValueError(f"Account not found: {account_id}")


def _ensure_fund_exists(connection, fund_id: str) -> None:
    exists = connection.execute(
        text("SELECT 1 FROM mpf.funds WHERE fund_id = :fund_id"),
        {"fund_id": fund_id},
    ).first()
    if not exists:
        raise ValueError(f"Fund not found: {fund_id}")


def _require_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} is required")
    return value.strip()


def _require_list(value: Any, field: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{field} must be a non-empty list")
    if not all(isinstance(item, dict) for item in value):
        raise ValueError(f"{field} must contain objects")
    return value


def _parse_uuid(value: Any, field: str) -> UUID:
    if value is None:
        raise ValueError(f"{field} is required")
    try:
        return UUID(str(value))
    except Exception as exc:
        raise ValueError(f"Invalid UUID for {field}") from exc


def _parse_date(value: Any, field: str) -> date:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be YYYY-MM-DD")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError(f"{field} must be YYYY-MM-DD") from exc


def _optional_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    return _parse_date(value, "effective_to")


def _parse_decimal(value: Any, field: str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid decimal for {field}") from exc
