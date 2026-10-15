from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Iterable, TypedDict

from sqlalchemy import text
from sqlalchemy.engine import Connection

from ..http_client import FetchResult, ProviderHttpError, request_with_retry
from ..pgsql.main import begin_connection
from ..snapshots import invalidate_price_snapshots


class ParseError(ValueError):
    pass


@dataclass(frozen=True)
class FundHistoryPoint:
    price_date: date
    price: Decimal


@dataclass(frozen=True)
class ManulifeFundRecord:
    fund_id: str
    fund_name: str
    currency: str


@dataclass(frozen=True)
class ManulifePriceRecord:
    fund_id: str
    fund_name: str
    currency: str
    price_date: date
    bid: Decimal
    offer: Decimal


class ManulifeCrawlResult(TypedDict):
    records: list[ManulifePriceRecord]
    funds_failed: list[dict[str, str]]


def crawl(*, from_date: date, to_date: date) -> ManulifeCrawlResult:
    """Fetch every fund history and return flat, save-ready price records."""
    if from_date > to_date:
        raise ValueError("from_date must be <= to_date")

    fundslist = fetch_manulife_fundslist(
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
    )
    funds = parse_manulife_fundslist(fundslist["payload"])
    funds_by_id = {fund.fund_id: fund for fund in funds}
    records: list[ManulifePriceRecord] = []
    funds_failed: list[dict[str, str]] = []

    with ThreadPoolExecutor(max_workers=3) as executor:
        future_map = {
            executor.submit(
                fetch_manulife_fundhistory,
                fund_id=fund_id,
                timeout_seconds=30.0,
                retries=3,
                backoff_seconds=1.5,
            ): fund
            for fund_id, fund in funds_by_id.items()
        }

        for future in as_completed(future_map):
            fund = future_map[future]
            try:
                fetched = future.result()
            except (ProviderHttpError, ValueError) as exc:
                funds_failed.append(
                    {
                        "fund_id": f"MANULIFE:{fund.fund_id}",
                        "error": str(exc),
                        "note": "fundhistory_fetch_failed",
                    }
                )
                continue

            try:
                price_history = parse_manulife_fundhistory(
                    fetched["payload"], expected_fund_id=fund.fund_id
                )
            except (ParseError, ValueError) as exc:
                funds_failed.append(
                    {
                        "fund_id": f"MANULIFE:{fund.fund_id}",
                        "error": str(exc),
                        "note": "fundhistory_parse_failed",
                    }
                )
                continue

            for point in price_history:
                if point.price_date < from_date or point.price_date > to_date:
                    continue
                if point.price == Decimal("0"):
                    continue

                records.append(
                    ManulifePriceRecord(
                        fund_id=fund.fund_id,
                        fund_name=fund.fund_name,
                        currency=fund.currency,
                        price_date=point.price_date,
                        bid=point.price,
                        offer=point.price,
                    )
                )

    return {
        "records": records,
        "funds_failed": funds_failed,
    }


def fetch_manulife_fundslist(
    *,
    timeout_seconds: float,
    retries: int,
    backoff_seconds: float,
) -> FetchResult:
    response = request_with_retry(
        timeout_seconds=timeout_seconds,
        retries=retries,
        backoff_seconds=backoff_seconds,
        method="GET",
        url="https://scmpf.manulife.com.hk/bin/funds/fundslist",
        params={"productLine": "mpf", "overrideLocale": "en_HK"},
        headers=_manulife_request_headers(),
    )
    return {
        "source": "manulife.fundslist",
        "payload": response.text,
        "status_code": response.status_code,
        "fetched_at": response.headers.get("date", ""),
    }


def parse_manulife_fundslist(payload: str) -> list[ManulifeFundRecord]:
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ParseError("Invalid Manulife fundslist JSON payload") from exc
    if not isinstance(data, list):
        raise ParseError("Manulife fundslist payload must be a top-level array")

    funds: list[ManulifeFundRecord] = []

    for index, raw_record in enumerate(data):
        if not isinstance(raw_record, dict):
            raise ParseError(
                f"Manulife fundslist record at index {index} is not an object"
            )

        fund_id = str(raw_record.get("fundId", "")).strip()
        fund_name = str(raw_record.get("fundName", "")).strip()
        currency = str(raw_record.get("currency", "")).strip() or "HKD"
        if not fund_id or not fund_name:
            raise ParseError(
                f"Manulife fundslist record at index {index} missing fundId/fundName"
            )

        funds.append(
            ManulifeFundRecord(
                fund_id=fund_id,
                fund_name=fund_name,
                currency=currency,
            )
        )
    return funds


def fetch_manulife_fundhistory(
    *,
    fund_id: str,
    timeout_seconds: float,
    retries: int,
    backoff_seconds: float,
) -> FetchResult:
    response = request_with_retry(
        timeout_seconds=timeout_seconds,
        retries=retries,
        backoff_seconds=backoff_seconds,
        method="GET",
        url="https://scmpf.manulife.com.hk/bin/funds/fundhistory",
        params={"id": fund_id, "productLine": "mpf", "overrideLocale": "en_HK"},
        headers=_manulife_request_headers(),
    )
    return {
        "source": "manulife.fundhistory",
        "payload": response.text,
        "status_code": response.status_code,
        "fetched_at": response.headers.get("date", ""),
    }


def parse_manulife_fundhistory(
    payload: str, *, expected_fund_id: str | None = None
) -> list[FundHistoryPoint]:
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ParseError("Invalid Manulife fundhistory JSON payload") from exc

    if not isinstance(data, dict):
        raise ParseError("Manulife fundhistory payload must be an object")

    if expected_fund_id is not None:
        actual_fund_id = data.get("fundId")
        if actual_fund_id != expected_fund_id:
            raise ParseError(
                f"Manulife fundhistory fundId mismatch: expected {expected_fund_id}, "
                f"got {actual_fund_id!r}"
            )

    price_histories = data.get("priceHistory")
    if not isinstance(price_histories, list):
        raise ParseError("Manulife fundhistory priceHistory must be an array")

    parsed_histories: list[FundHistoryPoint] = []
    for index, history in enumerate(price_histories):
        if not isinstance(history, dict):
            raise ParseError(
                f"Manulife priceHistory record at index {index} is not an object"
            )

        raw_price_date = history.get("asOfDate")
        raw_price = history.get("price")
        price_date = _try_parse_date(
            "" if raw_price_date is None else str(raw_price_date).strip()
        )
        price = _try_parse_decimal("" if raw_price is None else str(raw_price).strip())
        if price_date is None or price is None:
            raise ParseError(
                f"Manulife priceHistory record at index {index} has invalid asOfDate/price"
            )

        parsed_histories.append(
            FundHistoryPoint(
                price_date=price_date,
                price=price,
            )
        )

    if not parsed_histories:
        raise ParseError("Manulife fundhistory contains no priceHistory records")
    return parsed_histories


def save_records(
    pg_engine,
    records: Iterable[ManulifePriceRecord],
) -> dict[str, int | date | None]:
    """Store Manulife records and report the same write stats as HSBC."""
    inserted = updated = unchanged = 0
    min_changed_date: date | None = None
    max_changed_date: date | None = None
    changed_funds: dict[str, date] = {}

    with begin_connection(pg_engine) as pg_connection:
        for record in records:
            fund_id = is_fund_exists(pg_connection, record)

            row = (
                pg_connection.execute(
                    text("""
                    INSERT INTO mpf.fund_prices (fund_id, price_date, bid, offer, source, fetched_at, updated_at)
                    VALUES (:fund_id, :price_date, :bid, :offer, 'manulife_fundhistory', NOW(), NOW())
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
                    """),
                    {
                        "fund_id": fund_id,
                        "price_date": record.price_date,
                        "bid": record.bid,
                        "offer": record.offer,
                    },
                )
                .mappings()
                .first()
            )
            if row is None:
                unchanged += 1
                continue

            changed_funds[fund_id] = min(
                changed_funds.get(fund_id, record.price_date), record.price_date
            )
            if row["inserted"]:
                inserted += 1
            else:
                updated += 1

            if min_changed_date is None or record.price_date < min_changed_date:
                min_changed_date = record.price_date
            if max_changed_date is None or record.price_date > max_changed_date:
                max_changed_date = record.price_date

        invalidate_price_snapshots(pg_connection, changed_funds)

        return {
            "inserted": inserted,
            "updated": updated,
            "unchanged": unchanged,
            "min_changed_date": min_changed_date,
            "max_changed_date": max_changed_date,
        }


def is_fund_exists(connection: Connection, record: ManulifePriceRecord) -> str:
    existing = connection.execute(
        text("""
            SELECT fund_id
            FROM mpf.funds
            WHERE provider = 'manulife'
              AND provider_fund_code = :provider_fund_code
            LIMIT 1
            """),
        {"provider_fund_code": record.fund_id},
    ).scalar_one_or_none()
    if existing:
        update_fund(connection, str(existing))
        return str(existing)

    fund_id = f"MANULIFE:{record.fund_id}"
    connection.execute(
        text("""
            INSERT INTO mpf.funds (
                fund_id, provider, provider_fund_code, name, currency,
                last_seen_at, updated_at
            )
            VALUES (
                :fund_id, 'manulife', :provider_fund_code, :name, :currency,
                NOW(), NOW()
            )
            ON CONFLICT (fund_id)
            DO UPDATE SET
                name = EXCLUDED.name,
                currency = EXCLUDED.currency,
                last_seen_at = NOW(),
                updated_at = NOW()
            """),
        {
            "fund_id": fund_id,
            "provider_fund_code": record.fund_id,
            "name": record.fund_name,
            "currency": record.currency,
        },
    )
    connection.execute(
        text("""
            INSERT INTO mpf.fund_aliases (fund_id, alias, source)
            VALUES (:fund_id, :alias, 'manulife_fundslist')
            ON CONFLICT (fund_id, alias) DO NOTHING
            """),
        {"fund_id": fund_id, "alias": record.fund_name},
    )
    return fund_id


def update_fund(connection: Connection, fund_id: str) -> None:
    connection.execute(
        text(
            "UPDATE mpf.funds SET last_seen_at = NOW(), updated_at = NOW() WHERE fund_id = :fund_id"
        ),
        {"fund_id": fund_id},
    )


def _try_parse_date(value: str) -> date | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(value[:10], fmt).date()
        except ValueError:
            continue
    return None


def _try_parse_decimal(value: str) -> Decimal | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return Decimal(value)
    except InvalidOperation:
        return None


def _manulife_request_headers() -> dict[str, str]:
    return {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/154.0.0.0 Safari/537.36"
        ),
    }
