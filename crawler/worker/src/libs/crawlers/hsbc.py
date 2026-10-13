from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from io import StringIO
from typing import Iterable, TypedDict

from sqlalchemy import text
from sqlalchemy.engine import Connection

from ..http_client import FetchResult, request_with_retry
from ..pgsql.main import begin_connection


class ParseError(ValueError):
    pass


@dataclass(frozen=True)
class HsbcPriceRecord:
    fund_name: str
    price_date: date
    bid: Decimal
    offer: Decimal


class HsbcChunkMetadata(TypedDict):
    from_date: str
    to_date: str
    source: str
    status_code: int
    fetched_at: str


class HsbcCrawlResult(TypedDict):
    payload: str
    chunks: list[HsbcChunkMetadata]


def crawl(*, from_date: date, to_date: date) -> HsbcCrawlResult:
    if from_date > to_date:
        raise ValueError("from_date must be <= to_date")

    fetch_results: list[FetchResult] = []
    chunks: list[HsbcChunkMetadata] = []
    for chunk_from, chunk_to in _date_chunks(from_date, to_date, chunk_days=28):
        fetch_result = fetch_all_funds_csv(
            from_date=chunk_from,
            to_date=chunk_to,
            timeout_seconds=30.0,
            retries=3,
            backoff_seconds=1.5,
        )
        fetch_results.append(fetch_result)
        chunks.append(
            {
                "from_date": chunk_from.isoformat(),
                "to_date": chunk_to.isoformat(),
                "source": fetch_result["source"],
                "status_code": fetch_result["status_code"],
                "fetched_at": fetch_result["fetched_at"],
            }
        )

    return {
        "payload": (
            fetch_results[0]["payload"]
            if len(fetch_results) == 1
            else merge_csv_payloads(result["payload"] for result in fetch_results)
        ),
        "chunks": chunks,
    }


def _date_chunks(
    from_date: date, to_date: date, *, chunk_days: int
) -> Iterable[tuple[date, date]]:
    current = from_date
    while current <= to_date:
        current_end = min(current + timedelta(days=chunk_days - 1), to_date)
        yield (current, current_end)
        current = current_end + timedelta(days=1)


def fetch_all_funds_csv(
    *,
    from_date: date,
    to_date: date,
    timeout_seconds: float,
    retries: int,
    backoff_seconds: float,
) -> FetchResult:

    response = request_with_retry(
        timeout_seconds=timeout_seconds,
        retries=retries,
        backoff_seconds=backoff_seconds,
        method="GET",
        url=(
            "https://rbwm-api.hsbc.com.hk/"
            "wpb-gpbw-mmw-hk-hbap-pa-p-wpp-mpf-market-data-prod-proxy/v1/download-funds"
        ),
        params={
            "schemeCodes": "HB",
            "fundPricePeriodFrom": from_date.isoformat(),
            "fundPricePeriodTo": to_date.isoformat(),
            "language": "en_US",
        },
        headers={"Accept": "*/*"},
    )
    return {
        "source": "hsbc.download-funds",
        "payload": response.text,
        "status_code": response.status_code,
        "fetched_at": response.headers.get("date", ""),
    }


def merge_csv_payloads(payloads: Iterable[str]) -> str:
    merged_headers: list[list[str]] = []
    merged_funds: dict[str, list[str]] = {}
    fund_order: list[str] = []

    for payload in payloads:
        rows = list(csv.reader(StringIO(payload.lstrip("\ufeff"))))
        if len(rows) < 3 or len(rows[0]) < 3 or len(rows[0]) % 2 != 1:
            raise ParseError("HSBC CSV must include paired date columns and fund rows")
        if len(rows[1]) != len(rows[0]):
            raise ParseError("HSBC CSV header row width mismatch")

        chunk_funds: dict[str, list[str]] = {}
        for row in rows[2:]:
            if len(row) != len(rows[0]):
                raise ParseError("HSBC CSV fund row width mismatch")
            fund_name = row[0].strip()
            if not fund_name or fund_name in chunk_funds:
                raise ParseError(f"HSBC CSV missing or duplicate fund: {fund_name!r}")
            chunk_funds[fund_name] = row[1:]

        if not merged_headers:
            merged_headers = [rows[0][:], rows[1][:]]
            fund_order = list(chunk_funds)
            merged_funds = {name: values[:] for name, values in chunk_funds.items()}
            continue

        if rows[1][0] != merged_headers[1][0] or set(chunk_funds) != set(merged_funds):
            raise ParseError("HSBC CSV fund columns differ between date chunks")
        merged_headers[0].extend(rows[0][1:])
        merged_headers[1].extend(rows[1][1:])
        for name in fund_order:
            merged_funds[name].extend(chunk_funds[name])

    output = StringIO()
    writer = csv.writer(output)
    writer.writerows(merged_headers)
    writer.writerows([name, *merged_funds[name]] for name in fund_order)
    return output.getvalue()


def parse_all_funds_csv(payload: str) -> list[HsbcPriceRecord]:
    rows = list(csv.reader(StringIO(payload.lstrip("\ufeff"))))
    if len(rows) < 3:
        raise ParseError(
            "HSBC CSV must include two header rows and at least one data row"
        )

    column_count = len(rows[0])
    if len(rows[1]) != column_count:
        raise ParseError("HSBC CSV header row width mismatch")
    if column_count < 3 or (column_count - 1) % 2 != 0:
        raise ParseError("HSBC CSV must contain paired BID/OFFER columns")
    for row_index, row in enumerate(rows[2:], start=3):
        if len(row) != column_count:
            raise ParseError(f"HSBC row {row_index} width mismatch")

    transposed = list(zip(*rows, strict=True))
    fund_names = [value.strip() for value in transposed[0][2:]]
    if any(not fund_name for fund_name in fund_names):
        raise ParseError("HSBC CSV contains an empty fund name")
    if len(fund_names) != len(set(fund_names)):
        raise ParseError("HSBC CSV contains duplicate fund names")

    prices: dict[str, dict[date, dict[str, Decimal]]] = {
        fund_name: {} for fund_name in fund_names
    }
    seen_pairs: set[tuple[date, str]] = set()

    for row in transposed[1:]:
        price_date = _parse_date(row[0].strip())
        price_type = row[1].strip().lower()
        data_columns = row[2:]

        if price_type not in {"bid", "offer"}:
            raise ParseError(f"HSBC price rows must be BID/OFFER at date {price_date}")

        pair = (price_date, price_type)
        if pair in seen_pairs:
            if any(
                existing_date == price_date and existing_type != price_type
                for existing_date, existing_type in seen_pairs
            ):
                raise ParseError(
                    f"HSBC duplicate header pair for {price_date} {price_type}"
                )
            raise ParseError(f"HSBC price rows must be BID/OFFER at date {price_date}")
        seen_pairs.add(pair)

        for index, fund_name in enumerate(fund_names):
            if price_date not in prices[fund_name]:
                prices[fund_name][price_date] = {}

            prices[fund_name][price_date][price_type] = _parse_decimal(
                data_columns[index],
                f"HSBC {fund_name} {price_type.upper()} {price_date}",
            )

    records: list[HsbcPriceRecord] = []
    for fund_name, prices_by_date in prices.items():
        for price_date, values in prices_by_date.items():
            if set(values) != {"bid", "offer"}:
                raise ParseError(
                    f"HSBC price rows must be BID/OFFER for {fund_name} on {price_date}"
                )
            records.append(
                HsbcPriceRecord(
                    fund_name=fund_name,
                    price_date=price_date,
                    bid=values["bid"],
                    offer=values["offer"],
                )
            )
    return records


def save_records(pg_engine, records: Iterable[HsbcPriceRecord]):
    inserted = updated = unchanged = 0
    min_changed_date: date | None = None
    max_changed_date: date | None = None

    with begin_connection(pg_engine) as pg_connection:

        for record in records:
            fund_id = is_fund_exists(pg_connection, record.fund_name)

            row = (
                pg_connection.execute(
                    text("""
                    INSERT INTO mpf.fund_prices (fund_id, price_date, bid, offer, source, fetched_at, updated_at)
                    VALUES (:fund_id, :price_date, :bid, :offer, 'hsbc_csv', NOW(), NOW())
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

            if row["inserted"]:
                inserted += 1
            else:
                updated += 1
            if min_changed_date is None or record.price_date < min_changed_date:
                min_changed_date = record.price_date
            if max_changed_date is None or record.price_date > max_changed_date:
                max_changed_date = record.price_date

        return {
            "inserted": inserted,
            "updated": updated,
            "unchanged": unchanged,
            "min_changed_date": min_changed_date,
            "max_changed_date": max_changed_date,
        }


def is_fund_exists(pg_connection, fund_name: str) -> str:
    alias = fund_name.strip()

    existing = pg_connection.execute(
        text("""
            SELECT fa.fund_id
            FROM mpf.fund_aliases AS fa
            JOIN mpf.funds AS f ON f.fund_id = fa.fund_id
            WHERE f.provider = 'hsbc' AND fa.alias = :alias
            LIMIT 1
            """),
        {"alias": alias},
    ).scalar_one_or_none()
    if existing:
        update_fund(pg_connection, existing)
        return str(existing)

    provider_code = _slugify(fund_name)
    fund_id = f"HSBC:{provider_code}"
    pg_connection.execute(
        text("""
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
            """),
        {"fund_id": fund_id, "provider_fund_code": provider_code, "name": fund_name},
    )
    pg_connection.execute(
        text("""
            INSERT INTO mpf.fund_aliases (fund_id, alias, source)
            VALUES (:fund_id, :alias, 'hsbc_csv')
            ON CONFLICT (fund_id, alias) DO NOTHING
            """),
        {"fund_id": fund_id, "alias": alias},
    )
    pg_connection.execute(
        text("""
            INSERT INTO mpf.fund_scheme_memberships (fund_id, provider_scheme_code)
            VALUES (:fund_id, 'HB')
            ON CONFLICT (fund_id, provider_scheme_code) DO NOTHING
            """),
        {"fund_id": fund_id},
    )
    return fund_id


def update_fund(connection: Connection, fund_id: str) -> None:
    connection.execute(
        text(
            "UPDATE mpf.funds SET last_seen_at = NOW(), updated_at = NOW() WHERE fund_id = :fund_id"
        ),
        {"fund_id": fund_id},
    )


def _slugify(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", value.strip()).strip("_")
    cleaned = re.sub(r"_+", "_", cleaned)
    return cleaned.upper()[:64]


def _parse_decimal(value: str, field: str) -> Decimal:
    parsed = _try_parse_decimal(value)
    if parsed is None:
        raise ParseError(f"Invalid decimal value for {field}: {value!r}")
    return parsed


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


def _parse_date(value: str) -> date:
    parsed = _try_parse_date(value)
    if parsed is None:
        raise ParseError(f"Invalid date value: {value}")
    return parsed


def _try_parse_date(value: str) -> date | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(value[:10], fmt).date()
        except ValueError:
            continue
    return None
