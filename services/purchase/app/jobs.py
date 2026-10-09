from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from sqlalchemy import text

from shared.db import begin_connection
from services.purchase.app.invalidation import create_snapshot_invalidation_request


def build_job_handlers() -> dict[str, Any]:
    return {
        "process-due": handle_process_due,
        "confirm-purchase-event": handle_confirm_purchase_event,
    }


def handle_process_due(payload: dict[str, Any]) -> dict[str, Any]:
    as_of_date = _parse_date(payload.get("as_of_date")) or datetime.utcnow().date()
    maybe_account_id = payload.get("account_id")
    account_id = str(UUID(maybe_account_id)) if maybe_account_id else None

    processed_events = 0
    estimated_events = 0
    waiting_events = 0
    failed_events = 0
    inserted_transactions = 0
    updated_transactions = 0
    changed_from_date: date | None = None
    changed_to_date: date | None = None

    plans = _get_active_plans(as_of_date=as_of_date, account_id=account_id)
    for plan in plans:
        period = as_of_date.replace(day=1)
        expected_date = _expected_date_for_month(period=period, expected_day=plan["expected_day"])
        event = _upsert_contribution_event(
            plan_id=plan["plan_id"],
            period=period,
            expected_date=expected_date,
            amount=plan["amount"],
        )
        processed_events += 1
        event_status = str(event["status"])
        if event_status == "CONFIRMED":
            continue

        allocations = _load_allocations_for_period(
            account_id=plan["account_id"],
            contribution_stream=plan["contribution_stream"],
            period=period,
        )
        if not allocations:
            _set_event_status(event["event_id"], "FAILED_REVIEW")
            failed_events += 1
            continue

        total_weight = sum([item["weight"] for item in allocations], Decimal("0"))
        if total_weight != Decimal("100"):
            _set_event_status(event["event_id"], "FAILED_REVIEW")
            failed_events += 1
            continue

        priced_allocations: list[dict[str, Any]] = []
        missing_price = False
        for alloc in allocations:
            cash_amount = (plan["amount"] * alloc["weight"]) / Decimal("100")
            price_point = _find_price_for_estimation(
                fund_id=alloc["fund_id"],
                expected_date=expected_date,
                max_delay_days=14,
            )
            if price_point is None:
                missing_price = True
                break
            priced_allocations.append(
                {
                    "fund_id": alloc["fund_id"],
                    "cash_amount": cash_amount,
                    "unit_price": price_point["price"],
                    "trade_date": price_point["price_date"],
                }
            )

        if missing_price:
            _set_event_status(event["event_id"], "WAITING_FOR_PRICE")
            waiting_events += 1
            continue

        for alloc in priced_allocations:
            units_delta = alloc["cash_amount"] / alloc["unit_price"]
            inserted, changed = _upsert_estimated_transaction(
                event_id=event["event_id"],
                fund_id=alloc["fund_id"],
                trade_date=alloc["trade_date"],
                cash_amount=alloc["cash_amount"],
                unit_price=alloc["unit_price"],
                units_delta=units_delta,
            )
            if changed:
                if inserted:
                    inserted_transactions += 1
                else:
                    updated_transactions += 1
                changed_from_date = alloc["trade_date"] if changed_from_date is None else min(changed_from_date, alloc["trade_date"])
                changed_to_date = alloc["trade_date"] if changed_to_date is None else max(changed_to_date, alloc["trade_date"])

        _set_event_status(event["event_id"], "ESTIMATED")
        estimated_events += 1

    if changed_from_date:
        with begin_connection() as connection:
            create_snapshot_invalidation_request(
                connection,
                source_service="purchase",
                reason="purchase_estimation",
                from_date=changed_from_date,
                to_date=changed_to_date,
                account_id=account_id,
            )

    return {
        "as_of_date": as_of_date.isoformat(),
        "processed_events": processed_events,
        "estimated_events": estimated_events,
        "waiting_events": waiting_events,
        "failed_events": failed_events,
        "inserted_transactions": inserted_transactions,
        "updated_transactions": updated_transactions,
    }


def handle_confirm_purchase_event(payload: dict[str, Any]) -> dict[str, Any]:
    event_id = UUID(str(payload.get("event_id")))
    trade_date = _parse_date(payload.get("trade_date"))
    if trade_date is None:
        raise ValueError("trade_date is required")
    transactions = payload.get("transactions")
    if not isinstance(transactions, list) or not transactions:
        raise ValueError("transactions must be a non-empty list")

    changed_from_date: date | None = None
    changed_to_date: date | None = None
    confirmed_count = 0
    account_id: str | None = None
    with begin_connection() as connection:
        event_row = connection.execute(
            text(
                """
                SELECT e.event_id, p.account_id
                FROM mpf.contribution_events e
                JOIN mpf.contribution_plans p ON p.plan_id = e.plan_id
                WHERE e.event_id = :event_id
                """
            ),
            {"event_id": str(event_id)},
        ).mappings().first()
        if event_row is None:
            raise ValueError(f"Contribution event not found: {event_id}")
        account_id = str(event_row["account_id"])

        for transaction in transactions:
            fund_id = str(transaction.get("fund_id", "")).strip()
            if not fund_id:
                raise ValueError("transactions[].fund_id is required")
            cash_amount = _parse_decimal(transaction.get("cash_amount"), "transactions[].cash_amount")
            unit_price = _parse_decimal(transaction.get("unit_price"), "transactions[].unit_price")
            units_delta = _parse_decimal(transaction.get("units_delta"), "transactions[].units_delta")
            tx_trade_date = _parse_date(transaction.get("trade_date")) or trade_date
            row = connection.execute(
                text(
                    """
                    INSERT INTO mpf.purchase_transactions (
                        event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy
                    )
                    VALUES (
                        :event_id, :fund_id, :trade_date, :cash_amount, :unit_price, :units_delta, 'CONFIRMED',
                        'confirmed'
                    )
                    ON CONFLICT (event_id, fund_id)
                    DO UPDATE SET
                        trade_date = EXCLUDED.trade_date,
                        cash_amount = EXCLUDED.cash_amount,
                        unit_price = EXCLUDED.unit_price,
                        units_delta = EXCLUDED.units_delta,
                        status = 'CONFIRMED',
                        estimation_policy = 'confirmed',
                        updated_at = NOW()
                    RETURNING trade_date
                    """
                ),
                {
                    "event_id": str(event_id),
                    "fund_id": fund_id,
                    "trade_date": tx_trade_date,
                    "cash_amount": cash_amount,
                    "unit_price": unit_price,
                    "units_delta": units_delta,
                },
            ).mappings().one()
            confirmed_count += 1
            changed_from_date = row["trade_date"] if changed_from_date is None else min(changed_from_date, row["trade_date"])
            changed_to_date = row["trade_date"] if changed_to_date is None else max(changed_to_date, row["trade_date"])

        connection.execute(
            text(
                """
                UPDATE mpf.contribution_events
                SET status = 'CONFIRMED', updated_at = NOW()
                WHERE event_id = :event_id
                """
            ),
            {"event_id": str(event_id)},
        )
        if changed_from_date:
            create_snapshot_invalidation_request(
                connection,
                source_service="purchase",
                reason="purchase_confirmation",
                from_date=changed_from_date,
                to_date=changed_to_date,
                account_id=account_id,
            )

    return {"event_id": str(event_id), "confirmed_transactions": confirmed_count}


def _get_active_plans(*, as_of_date: date, account_id: str | None) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"as_of_date": as_of_date}
    account_filter = ""
    if account_id is not None:
        account_filter = "AND account_id = :account_id"
        params["account_id"] = account_id
    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT
                    plan_id, account_id, contribution_stream, amount, expected_day
                FROM mpf.contribution_plans
                WHERE active = TRUE
                  AND effective_from <= :as_of_date
                  AND (effective_to IS NULL OR effective_to >= :as_of_date)
                  {account_filter}
                ORDER BY plan_id
                """.format(account_filter=account_filter)
            ),
            params,
        ).mappings().all()
    return [dict(row) for row in rows]


def _load_allocations_for_period(
    *,
    account_id: UUID,
    contribution_stream: str,
    period: date,
) -> list[dict[str, Any]]:
    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                WITH selected_version AS (
                    SELECT MAX(effective_from) AS effective_from
                    FROM mpf.allocation_rules
                    WHERE account_id = :account_id
                      AND contribution_stream = :contribution_stream
                      AND effective_from <= :period
                      AND (effective_to IS NULL OR effective_to >= :period)
                )
                SELECT ar.fund_id, ar.weight
                FROM mpf.allocation_rules ar
                JOIN selected_version sv ON ar.effective_from = sv.effective_from
                WHERE ar.account_id = :account_id
                  AND ar.contribution_stream = :contribution_stream
                ORDER BY ar.fund_id
                """
            ),
            {
                "account_id": str(account_id),
                "contribution_stream": contribution_stream,
                "period": period,
            },
        ).mappings().all()
    return [{"fund_id": row["fund_id"], "weight": row["weight"]} for row in rows]


def _upsert_contribution_event(
    *,
    plan_id: UUID,
    period: date,
    expected_date: date,
    amount: Decimal,
) -> dict[str, Any]:
    with begin_connection() as connection:
        row = connection.execute(
            text(
                """
                INSERT INTO mpf.contribution_events (
                    plan_id, period, expected_date, amount, status
                )
                VALUES (:plan_id, :period, :expected_date, :amount, 'EXPECTED')
                ON CONFLICT (plan_id, period)
                DO UPDATE SET
                    expected_date = EXCLUDED.expected_date,
                    amount = EXCLUDED.amount,
                    updated_at = NOW()
                RETURNING event_id, status
                """
            ),
            {
                "plan_id": str(plan_id),
                "period": period,
                "expected_date": expected_date,
                "amount": amount,
            },
        ).mappings().one()
    return dict(row)


def _find_price_for_estimation(
    *,
    fund_id: str,
    expected_date: date,
    max_delay_days: int,
) -> dict[str, Any] | None:
    latest_date = expected_date + timedelta(days=max_delay_days)
    with begin_connection() as connection:
        row = connection.execute(
            text(
                """
                SELECT fp.price_date,
                       CASE
                         WHEN f.provider = 'hsbc' THEN fp.bid
                         WHEN f.provider = 'manulife' THEN fp.nav
                         ELSE COALESCE(fp.nav, fp.bid, fp.offer)
                       END AS price
                FROM mpf.fund_prices fp
                JOIN mpf.funds f ON f.fund_id = fp.fund_id
                WHERE fp.fund_id = :fund_id
                  AND fp.price_date >= :expected_date
                  AND fp.price_date <= :latest_date
                ORDER BY fp.price_date ASC
                LIMIT 1
                """
            ),
            {"fund_id": fund_id, "expected_date": expected_date, "latest_date": latest_date},
        ).mappings().first()
    if row is None or row["price"] is None:
        return None
    return {"price_date": row["price_date"], "price": row["price"]}


def _upsert_estimated_transaction(
    *,
    event_id: UUID,
    fund_id: str,
    trade_date: date,
    cash_amount: Decimal,
    unit_price: Decimal,
    units_delta: Decimal,
) -> tuple[bool, bool]:
    with begin_connection() as connection:
        row = connection.execute(
            text(
                """
                INSERT INTO mpf.purchase_transactions (
                    event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy
                )
                VALUES (
                    :event_id, :fund_id, :trade_date, :cash_amount, :unit_price, :units_delta, 'ESTIMATED',
                    'first_price_on_or_after'
                )
                ON CONFLICT (event_id, fund_id)
                DO UPDATE SET
                    trade_date = EXCLUDED.trade_date,
                    cash_amount = EXCLUDED.cash_amount,
                    unit_price = EXCLUDED.unit_price,
                    units_delta = EXCLUDED.units_delta,
                    status = CASE
                        WHEN mpf.purchase_transactions.status = 'CONFIRMED' THEN mpf.purchase_transactions.status
                        ELSE 'ESTIMATED'
                    END,
                    estimation_policy = CASE
                        WHEN mpf.purchase_transactions.status = 'CONFIRMED' THEN mpf.purchase_transactions.estimation_policy
                        ELSE 'first_price_on_or_after'
                    END,
                    updated_at = NOW()
                WHERE mpf.purchase_transactions.status <> 'CONFIRMED'
                  AND (
                      mpf.purchase_transactions.trade_date IS DISTINCT FROM EXCLUDED.trade_date
                      OR mpf.purchase_transactions.cash_amount IS DISTINCT FROM EXCLUDED.cash_amount
                      OR mpf.purchase_transactions.unit_price IS DISTINCT FROM EXCLUDED.unit_price
                      OR mpf.purchase_transactions.units_delta IS DISTINCT FROM EXCLUDED.units_delta
                  )
                RETURNING (xmax = 0) AS inserted
                """
            ),
            {
                "event_id": str(event_id),
                "fund_id": fund_id,
                "trade_date": trade_date,
                "cash_amount": cash_amount,
                "unit_price": unit_price,
                "units_delta": units_delta,
            },
        ).mappings().first()
    if row is None:
        return (False, False)
    return (bool(row["inserted"]), True)


def _set_event_status(event_id: UUID, status_value: str) -> None:
    with begin_connection() as connection:
        connection.execute(
            text(
                """
                UPDATE mpf.contribution_events
                SET status = :status_value, updated_at = NOW()
                WHERE event_id = :event_id
                """
            ),
            {"status_value": status_value, "event_id": str(event_id)},
        )


def _expected_date_for_month(*, period: date, expected_day: int) -> date:
    last_day = calendar.monthrange(period.year, period.month)[1]
    return period.replace(day=min(expected_day, last_day))


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


def _parse_decimal(value: Any, field: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid decimal for {field}") from exc
    return parsed
