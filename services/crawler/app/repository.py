from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Iterable

from sqlalchemy import text
from sqlalchemy.engine import Connection

from services.crawler.app.parsers import HsbcPriceRecord, ManulifeFundRecord


@dataclass(frozen=True)
class PriceUpsertStats:
    inserted: int
    updated: int
    unchanged: int
    min_changed_date: date | None
    max_changed_date: date | None


def ensure_hsbc_fund(connection: Connection, fund_name: str) -> str:
    alias = fund_name.strip()
    existing = connection.execute(
        text(
            """
            SELECT fa.fund_id
            FROM mpf.fund_aliases AS fa
            JOIN mpf.funds AS f ON f.fund_id = fa.fund_id
            WHERE f.provider = 'hsbc' AND fa.alias = :alias
            LIMIT 1
            """
        ),
        {"alias": alias},
    ).scalar_one_or_none()
    if existing:
        _touch_fund(connection, existing)
        return str(existing)

    provider_code = _slugify(fund_name)
    fund_id = f"HSBC:{provider_code}"
    connection.execute(
        text(
            """
            INSERT INTO mpf.funds (
                fund_id, provider, provider_fund_code, name, currency, metadata, last_seen_at, updated_at
            )
            VALUES (
                :fund_id, 'hsbc', :provider_fund_code, :name, 'HKD', '{}'::JSONB, NOW(), NOW()
            )
            ON CONFLICT (fund_id)
            DO UPDATE SET
                name = EXCLUDED.name,
                last_seen_at = NOW(),
                updated_at = NOW()
            """
        ),
        {"fund_id": fund_id, "provider_fund_code": provider_code, "name": fund_name},
    )
    connection.execute(
        text(
            """
            INSERT INTO mpf.fund_aliases (fund_id, alias, source)
            VALUES (:fund_id, :alias, 'hsbc_csv')
            ON CONFLICT (fund_id, alias) DO NOTHING
            """
        ),
        {"fund_id": fund_id, "alias": alias},
    )
    connection.execute(
        text(
            """
            INSERT INTO mpf.fund_scheme_memberships (fund_id, provider_scheme_code)
            VALUES (:fund_id, 'HB')
            ON CONFLICT (fund_id, provider_scheme_code) DO NOTHING
            """
        ),
        {"fund_id": fund_id},
    )
    return fund_id


def upsert_manulife_fund(connection: Connection, record: ManulifeFundRecord) -> str:
    fund_id = f"MANULIFE:{record.fund_id}"
    connection.execute(
        text(
            """
            INSERT INTO mpf.funds (
                fund_id, provider, provider_fund_code, name, currency,
                asset_class, risk_rating, interest_fund_flag, metadata, last_seen_at, updated_at
            )
            VALUES (
                :fund_id, 'manulife', :provider_fund_code, :name, :currency,
                :asset_class, :risk_rating, :interest_fund_flag, CAST(:metadata AS JSONB), NOW(), NOW()
            )
            ON CONFLICT (fund_id)
            DO UPDATE SET
                name = EXCLUDED.name,
                currency = EXCLUDED.currency,
                asset_class = EXCLUDED.asset_class,
                risk_rating = EXCLUDED.risk_rating,
                interest_fund_flag = EXCLUDED.interest_fund_flag,
                metadata = EXCLUDED.metadata,
                last_seen_at = NOW(),
                updated_at = NOW()
            """
        ),
        {
            "fund_id": fund_id,
            "provider_fund_code": record.fund_id,
            "name": record.fund_name,
            "currency": record.currency,
            "asset_class": record.asset_class,
            "risk_rating": record.risk_rating,
            "interest_fund_flag": record.interest_fund_flag,
            "metadata": _json_dump(record.raw_metadata),
        },
    )
    connection.execute(
        text(
            """
            INSERT INTO mpf.fund_aliases (fund_id, alias, source)
            VALUES (:fund_id, :alias, 'manulife_fundslist')
            ON CONFLICT (fund_id, alias) DO NOTHING
            """
        ),
        {"fund_id": fund_id, "alias": record.fund_name},
    )
    for product_id in record.products_id:
        connection.execute(
            text(
                """
                INSERT INTO mpf.fund_scheme_memberships (fund_id, provider_scheme_code)
                VALUES (:fund_id, :provider_scheme_code)
                ON CONFLICT (fund_id, provider_scheme_code) DO NOTHING
                """
            ),
            {"fund_id": fund_id, "provider_scheme_code": product_id},
        )
    return fund_id


def upsert_hsbc_prices(connection: Connection, records: Iterable[HsbcPriceRecord]) -> PriceUpsertStats:
    inserted = updated = unchanged = 0
    min_changed_date: date | None = None
    max_changed_date: date | None = None

    for record in records:
        fund_id = ensure_hsbc_fund(connection, record.fund_name)
        row = connection.execute(
            text(
                """
                INSERT INTO mpf.fund_prices (fund_id, price_date, bid, offer, nav, source, fetched_at, updated_at)
                VALUES (:fund_id, :price_date, :bid, :offer, NULL, 'hsbc_csv', NOW(), NOW())
                ON CONFLICT (fund_id, price_date)
                DO UPDATE
                SET
                    bid = EXCLUDED.bid,
                    offer = EXCLUDED.offer,
                    source = EXCLUDED.source,
                    fetched_at = EXCLUDED.fetched_at,
                    updated_at = NOW()
                WHERE mpf.fund_prices.bid IS DISTINCT FROM EXCLUDED.bid
                   OR mpf.fund_prices.offer IS DISTINCT FROM EXCLUDED.offer
                RETURNING (xmax = 0) AS inserted
                """
            ),
            {
                "fund_id": fund_id,
                "price_date": record.price_date,
                "bid": record.bid,
                "offer": record.offer,
            },
        ).mappings().first()
        if row is None:
            unchanged += 1
            continue

        if row["inserted"]:
            inserted += 1
        else:
            updated += 1
        if min_changed_date is None or record.price_date < min_changed_date:
            min_changed_date = record.price_date
        if max_changed_date is None or record.price_date > max_changed_date:
            max_changed_date = record.price_date

    return PriceUpsertStats(
        inserted=inserted,
        updated=updated,
        unchanged=unchanged,
        min_changed_date=min_changed_date,
        max_changed_date=max_changed_date,
    )


def upsert_manulife_nav_price(
    connection: Connection,
    *,
    fund_id: str,
    price_date: date,
    nav: Decimal,
    source: str,
) -> tuple[bool, bool]:
    """
    Returns (inserted, changed).
    """
    row = connection.execute(
        text(
            """
            INSERT INTO mpf.fund_prices (fund_id, price_date, bid, offer, nav, source, fetched_at, updated_at)
            VALUES (:fund_id, :price_date, NULL, NULL, :nav, :source, NOW(), NOW())
            ON CONFLICT (fund_id, price_date)
            DO UPDATE
            SET
                nav = EXCLUDED.nav,
                source = EXCLUDED.source,
                fetched_at = EXCLUDED.fetched_at,
                updated_at = NOW()
            WHERE mpf.fund_prices.nav IS DISTINCT FROM EXCLUDED.nav
            RETURNING (xmax = 0) AS inserted
            """
        ),
        {
            "fund_id": fund_id,
            "price_date": price_date,
            "nav": nav,
            "source": source,
        },
    ).mappings().first()
    if row is None:
        return (False, False)
    return (bool(row["inserted"]), True)


def list_manulife_fund_ids(connection: Connection) -> list[str]:
    rows = connection.execute(
        text(
            """
            SELECT fund_id
            FROM mpf.funds
            WHERE provider = 'manulife'
            ORDER BY fund_id
            """
        )
    ).scalars().all()
    return [str(value) for value in rows]


def _touch_fund(connection: Connection, fund_id: str) -> None:
    connection.execute(
        text("UPDATE mpf.funds SET last_seen_at = NOW(), updated_at = NOW() WHERE fund_id = :fund_id"),
        {"fund_id": fund_id},
    )


def _slugify(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", value.strip()).strip("_")
    cleaned = re.sub(r"_+", "_", cleaned)
    return cleaned.upper()[:64]


def _json_dump(value: dict) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
