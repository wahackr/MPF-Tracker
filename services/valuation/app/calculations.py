from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import text

from shared.db import begin_connection


@dataclass
class HoldingRow:
    account_id: UUID
    fund_id: str
    baseline_date: date
    baseline_units: Decimal
    verification_status: str
    confirmed_delta: Decimal
    estimated_delta: Decimal


def calculate_portfolio_as_of(
    *,
    as_of_date: date,
    account_id: UUID | None = None,
    include_estimated: bool = True,
    stale_after_days: int = 3,
) -> dict[str, Any]:
    holdings = _load_holdings(as_of_date=as_of_date, account_id=account_id)
    account_map: dict[str, dict[str, Any]] = {}

    for holding in holdings:
        account_key = str(holding.account_id)
        account_entry = account_map.setdefault(
            account_key,
            {
                "account_id": account_key,
                "currency": "HKD",
                "funds": [],
                "priced_subtotal": Decimal("0"),
                "total_value": Decimal("0"),
                "unpriced_fund_count": 0,
                "any_stale": False,
            },
        )
        units = holding.baseline_units + holding.confirmed_delta
        estimated_component = False
        if include_estimated:
            units += holding.estimated_delta
            estimated_component = holding.estimated_delta != 0
        if holding.verification_status != "VERIFIED":
            estimated_component = True

        price_info = _load_latest_price(fund_id=holding.fund_id, as_of_date=as_of_date)
        fund_payload = {
            "fund_id": holding.fund_id,
            "units": str(units),
            "baseline_date": holding.baseline_date.isoformat(),
            "baseline_verification_status": holding.verification_status,
            "units_status": "ESTIMATED" if estimated_component else "VERIFIED",
            "price_date": None,
            "price": None,
            "price_type": None,
            "days_stale": None,
            "is_stale": False,
            "market_value": None,
            "price_status": "MISSING",
        }

        if price_info:
            price_date = price_info["price_date"]
            price = price_info["price"]
            price_type = price_info["price_type"]
            days_stale = (as_of_date - price_date).days
            is_stale = days_stale > stale_after_days
            market_value = units * price
            fund_payload.update(
                {
                    "price_date": price_date.isoformat(),
                    "price": str(price),
                    "price_type": price_type,
                    "days_stale": days_stale,
                    "is_stale": is_stale,
                    "market_value": str(market_value),
                    "price_status": "STALE" if is_stale else "FRESH",
                }
            )
            account_entry["priced_subtotal"] += market_value
            account_entry["total_value"] += market_value
            account_entry["any_stale"] = account_entry["any_stale"] or is_stale
        else:
            account_entry["unpriced_fund_count"] += 1
        account_entry["funds"].append(fund_payload)

    account_results = []
    aggregate_priced_subtotal = Decimal("0")
    total_unpriced = 0
    any_stale = False
    for account in account_map.values():
        aggregate_priced_subtotal += account["priced_subtotal"]
        total_unpriced += account["unpriced_fund_count"]
        any_stale = any_stale or account["any_stale"]
        if account["unpriced_fund_count"] > 0:
            calculation_status = "PARTIAL"
            total_value = None
        elif account["any_stale"]:
            calculation_status = "STALE"
            total_value = account["total_value"]
        else:
            calculation_status = "COMPLETE"
            total_value = account["total_value"]
        account_results.append(
            {
                "account_id": account["account_id"],
                "currency": account["currency"],
                "calculation_status": calculation_status,
                "total_value": str(total_value) if total_value is not None else None,
                "priced_subtotal": str(account["priced_subtotal"]),
                "unpriced_fund_count": account["unpriced_fund_count"],
                "funds": account["funds"],
            }
        )

    if total_unpriced > 0:
        overall_status = "PARTIAL"
        overall_total = None
    elif any_stale:
        overall_status = "STALE"
        overall_total = aggregate_priced_subtotal
    else:
        overall_status = "COMPLETE"
        overall_total = aggregate_priced_subtotal

    return {
        "requested_as_of": as_of_date.isoformat(),
        "calculated_at": datetime.utcnow().isoformat() + "Z",
        "currency": "HKD",
        "calculation_status": overall_status,
        "total_value": str(overall_total) if overall_total is not None else None,
        "priced_subtotal": str(aggregate_priced_subtotal),
        "unpriced_fund_count": total_unpriced,
        "accounts": sorted(account_results, key=lambda item: item["account_id"]),
    }


def persist_snapshot(calculation: dict[str, Any]) -> dict[str, Any]:
    as_of_date = datetime.strptime(calculation["requested_as_of"], "%Y-%m-%d").date()
    saved_accounts = 0
    with begin_connection() as connection:
        for account in calculation["accounts"]:
            account_id = account["account_id"]
            row = connection.execute(
                text(
                    """
                    INSERT INTO mpf.portfolio_snapshots (
                        account_id, as_of_date, total_value, currency, calculation_status, calculated_at, revision, stale
                    )
                    VALUES (
                        :account_id, :as_of_date, :total_value, :currency, :calculation_status, NOW(), 1,
                        :stale
                    )
                    ON CONFLICT (account_id, as_of_date)
                    DO UPDATE SET
                        total_value = EXCLUDED.total_value,
                        currency = EXCLUDED.currency,
                        calculation_status = EXCLUDED.calculation_status,
                        calculated_at = NOW(),
                        stale = EXCLUDED.stale,
                        revision = mpf.portfolio_snapshots.revision + 1,
                        updated_at = NOW()
                    RETURNING revision
                    """
                ),
                {
                    "account_id": account_id,
                    "as_of_date": as_of_date,
                    "total_value": account["total_value"],
                    "currency": account["currency"],
                    "calculation_status": account["calculation_status"],
                    "stale": account["calculation_status"] in {"STALE", "PARTIAL"},
                },
            ).mappings().one()

            connection.execute(
                text(
                    """
                    DELETE FROM mpf.snapshot_fund_values
                    WHERE account_id = :account_id AND as_of_date = :as_of_date
                    """
                ),
                {"account_id": account_id, "as_of_date": as_of_date},
            )
            for fund in account["funds"]:
                connection.execute(
                    text(
                        """
                        INSERT INTO mpf.snapshot_fund_values (
                            account_id, as_of_date, fund_id, units, price_date, price_used,
                            value, price_status, units_status
                        )
                        VALUES (
                            :account_id, :as_of_date, :fund_id, :units, :price_date, :price_used,
                            :value, :price_status, :units_status
                        )
                        """
                    ),
                    {
                        "account_id": account_id,
                        "as_of_date": as_of_date,
                        "fund_id": fund["fund_id"],
                        "units": fund["units"],
                        "price_date": fund["price_date"],
                        "price_used": fund["price"],
                        "value": fund["market_value"],
                        "price_status": fund["price_status"],
                        "units_status": fund["units_status"],
                    },
                )
            saved_accounts += 1
    return {"saved_accounts": saved_accounts}


def _load_holdings(*, as_of_date: date, account_id: UUID | None) -> list[HoldingRow]:
    account_filter = ""
    params: dict[str, Any] = {"as_of_date": as_of_date}
    if account_id is not None:
        account_filter = "AND hb.account_id = :account_id"
        params["account_id"] = str(account_id)

    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                WITH latest_baselines AS (
                    SELECT
                        hb.account_id,
                        hb.fund_id,
                        hb.effective_date,
                        hb.units,
                        hb.verification_status,
                        ROW_NUMBER() OVER (
                            PARTITION BY hb.account_id, hb.fund_id
                            ORDER BY hb.effective_date DESC, hb.created_at DESC, hb.baseline_id DESC
                        ) AS rn
                    FROM mpf.holdings_baselines hb
                    WHERE hb.effective_date <= :as_of_date
                      {account_filter}
                )
                SELECT
                    b.account_id,
                    b.fund_id,
                    b.effective_date,
                    b.units,
                    b.verification_status,
                    COALESCE(SUM(CASE WHEN pt.status = 'CONFIRMED' THEN pt.units_delta ELSE 0 END), 0) AS confirmed_delta,
                    COALESCE(SUM(CASE WHEN pt.status = 'ESTIMATED' THEN pt.units_delta ELSE 0 END), 0) AS estimated_delta
                FROM latest_baselines b
                LEFT JOIN mpf.contribution_plans cp ON cp.account_id = b.account_id
                LEFT JOIN mpf.contribution_events ce ON ce.plan_id = cp.plan_id
                LEFT JOIN mpf.purchase_transactions pt
                    ON pt.event_id = ce.event_id
                   AND pt.fund_id = b.fund_id
                   AND pt.trade_date > b.effective_date
                   AND pt.trade_date <= :as_of_date
                WHERE b.rn = 1
                GROUP BY b.account_id, b.fund_id, b.effective_date, b.units, b.verification_status
                ORDER BY b.account_id, b.fund_id
                """.format(account_filter=account_filter)
            ),
            params,
        ).mappings().all()

    results: list[HoldingRow] = []
    for row in rows:
        results.append(
            HoldingRow(
                account_id=row["account_id"],
                fund_id=row["fund_id"],
                baseline_date=row["effective_date"],
                baseline_units=row["units"],
                verification_status=row["verification_status"],
                confirmed_delta=row["confirmed_delta"],
                estimated_delta=row["estimated_delta"],
            )
        )
    return results


def _load_latest_price(*, fund_id: str, as_of_date: date) -> dict[str, Any] | None:
    with begin_connection() as connection:
        row = connection.execute(
            text(
                """
                SELECT
                    fp.price_date,
                    CASE
                        WHEN f.provider = 'hsbc' THEN fp.bid
                        WHEN f.provider = 'manulife' THEN fp.nav
                        ELSE COALESCE(fp.nav, fp.bid, fp.offer)
                    END AS price,
                    CASE
                        WHEN f.provider = 'hsbc' THEN 'BID'
                        WHEN f.provider = 'manulife' THEN 'NAV'
                        WHEN fp.nav IS NOT NULL THEN 'NAV'
                        WHEN fp.bid IS NOT NULL THEN 'BID'
                        WHEN fp.offer IS NOT NULL THEN 'OFFER'
                        ELSE 'UNKNOWN'
                    END AS price_type
                FROM mpf.fund_prices fp
                JOIN mpf.funds f ON f.fund_id = fp.fund_id
                WHERE fp.fund_id = :fund_id
                  AND fp.price_date <= :as_of_date
                ORDER BY fp.price_date DESC
                LIMIT 1
                """
            ),
            {"fund_id": fund_id, "as_of_date": as_of_date},
        ).mappings().first()
    if row is None or row["price"] is None:
        return None
    return {"price_date": row["price_date"], "price": row["price"], "price_type": row["price_type"]}
