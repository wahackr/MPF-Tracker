from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from io import StringIO
from typing import Any


class ParseError(ValueError):
    pass


@dataclass(frozen=True)
class HsbcPriceRecord:
    fund_name: str
    price_date: date
    bid: Decimal
    offer: Decimal


@dataclass(frozen=True)
class ManulifeFundRecord:
    fund_id: str
    fund_name: str
    currency: str
    display_frontend: bool
    products_id: list[str]
    risk_rating: str | None
    asset_class: str | None
    interest_fund_flag: bool
    nav_as_of_date: date | None
    nav_price: Decimal | None
    raw_metadata: dict[str, Any]


@dataclass(frozen=True)
class FundHistoryPoint:
    price_date: date
    nav: Decimal


def parse_hsbc_all_funds_csv(payload: str) -> list[HsbcPriceRecord]:
    text = payload.lstrip("\ufeff")
    rows = list(csv.reader(StringIO(text)))
    if len(rows) < 3:
        raise ParseError("HSBC CSV must include two header rows and at least one data row")

    date_row = rows[0]
    type_row = rows[1]
    column_count = len(date_row)
    if len(type_row) != column_count:
        raise ParseError("HSBC CSV header row width mismatch")
    if column_count < 3 or (column_count - 1) % 2 != 0:
        raise ParseError("HSBC CSV must contain paired BID/OFFER columns")

    column_mappings: list[tuple[int, int, date]] = []
    seen_pairs: set[tuple[date, str]] = set()
    for idx in range(1, column_count, 2):
        bid_idx = idx
        offer_idx = idx + 1

        raw_bid_date = date_row[bid_idx].strip()
        raw_offer_date = date_row[offer_idx].strip()
        if raw_bid_date != raw_offer_date:
            raise ParseError(f"HSBC header date pair mismatch at columns {bid_idx}/{offer_idx}")

        parsed_date = _parse_date(raw_bid_date)
        bid_type = type_row[bid_idx].strip().upper()
        offer_type = type_row[offer_idx].strip().upper()
        if bid_type != "BID" or offer_type != "OFFER":
            raise ParseError(f"HSBC header type pair must be BID/OFFER at date {raw_bid_date}")

        for pair in ((parsed_date, "BID"), (parsed_date, "OFFER")):
            if pair in seen_pairs:
                raise ParseError(f"HSBC duplicate header pair for {pair[0]} {pair[1]}")
            seen_pairs.add(pair)

        column_mappings.append((bid_idx, offer_idx, parsed_date))

    records: list[HsbcPriceRecord] = []
    for row_index, row in enumerate(rows[2:], start=3):
        if len(row) != column_count:
            raise ParseError(f"HSBC row {row_index} width mismatch")
        fund_name = row[0].strip()
        if not fund_name:
            raise ParseError(f"HSBC row {row_index} missing fund name")

        for bid_idx, offer_idx, price_date in column_mappings:
            bid = _parse_decimal(row[bid_idx], f"HSBC row {row_index} BID {price_date}")
            offer = _parse_decimal(row[offer_idx], f"HSBC row {row_index} OFFER {price_date}")
            records.append(
                HsbcPriceRecord(
                    fund_name=fund_name,
                    price_date=price_date,
                    bid=bid,
                    offer=offer,
                )
            )
    return records


def parse_manulife_fundslist(payload: str) -> list[ManulifeFundRecord]:
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ParseError("Invalid Manulife fundslist JSON payload") from exc
    if not isinstance(data, list):
        raise ParseError("Manulife fundslist payload must be a top-level array")

    records: list[ManulifeFundRecord] = []
    for index, raw_record in enumerate(data):
        if not isinstance(raw_record, dict):
            raise ParseError(f"Manulife fundslist record at index {index} is not an object")

        fund_id = str(raw_record.get("fundId", "")).strip()
        fund_name = str(raw_record.get("fundName", "")).strip()
        currency = str(raw_record.get("currency", "")).strip() or "HKD"
        if not fund_id or not fund_name:
            raise ParseError(f"Manulife fundslist record at index {index} missing fundId/fundName")

        products_id = [str(item) for item in (raw_record.get("productsId") or [])]
        nav = raw_record.get("nav") if isinstance(raw_record.get("nav"), dict) else {}
        nav_as_of_date = _try_parse_date(str(nav.get("asOfDate", "")).strip())
        nav_price_raw = str(nav.get("price", "")).strip()
        nav_price = _try_parse_decimal(nav_price_raw)
        interest_fund_flag = str(nav.get("fundInterestInd", "")).upper() == "Y"

        records.append(
            ManulifeFundRecord(
                fund_id=fund_id,
                fund_name=fund_name,
                currency=currency,
                display_frontend=bool(raw_record.get("displayFrontend", False)),
                products_id=products_id,
                risk_rating=_null_if_empty(str(raw_record.get("riskRating", "")).strip()),
                asset_class=_null_if_empty(str(raw_record.get("assetClassName", "")).strip()),
                interest_fund_flag=interest_fund_flag,
                nav_as_of_date=nav_as_of_date,
                nav_price=nav_price,
                raw_metadata=raw_record,
            )
        )
    return records


def parse_manulife_fundhistory(payload: str) -> list[FundHistoryPoint]:
    """
    Real JSON schema has not been verified in this environment due HTTP access denied.
    This parser intentionally handles only known key shapes and raises ParseError
    for unknown layouts to avoid silently fabricating history.
    """
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ParseError("Invalid Manulife fundhistory JSON payload") from exc

    candidate_lists: list[list[dict[str, Any]]] = []
    if isinstance(data, list):
        if all(isinstance(item, dict) for item in data):
            candidate_lists.append(data)
    elif isinstance(data, dict):
        for key in ("history", "data", "fundHistory", "prices", "navHistory"):
            value = data.get(key)
            if isinstance(value, list) and all(isinstance(item, dict) for item in value):
                candidate_lists.append(value)
    if not candidate_lists:
        raise ParseError("Unsupported Manulife fundhistory schema: no recognizable history array")

    points: list[FundHistoryPoint] = []
    for series in candidate_lists:
        for record in series:
            parsed = _extract_history_point(record)
            if parsed is not None:
                points.append(parsed)
        if points:
            break
    if not points:
        raise ParseError("No valid Manulife fundhistory points found")
    return sorted(points, key=lambda item: item.price_date)


def _extract_history_point(record: dict[str, Any]) -> FundHistoryPoint | None:
    date_candidates = ("date", "asOfDate", "priceDate", "navDate")
    price_candidates = ("price", "nav", "unitPrice", "value")

    parsed_date: date | None = None
    for key in date_candidates:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            parsed_date = _try_parse_date(value.strip())
            if parsed_date:
                break

    parsed_price: Decimal | None = None
    for key in price_candidates:
        value = record.get(key)
        if value is None:
            continue
        parsed_price = _try_parse_decimal(str(value).strip())
        if parsed_price is not None:
            break

    if parsed_date and parsed_price is not None:
        return FundHistoryPoint(price_date=parsed_date, nav=parsed_price)
    return None


def _null_if_empty(value: str) -> str | None:
    return value or None


def _parse_date(value: str) -> date:
    parsed = _try_parse_date(value)
    if parsed is None:
        raise ParseError(f"Invalid date value: {value}")
    return parsed


def _try_parse_date(value: str) -> date | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(value[:10], fmt).date()
        except ValueError:
            continue
    return None


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

