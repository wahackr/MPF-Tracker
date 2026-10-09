from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from .db import begin_connection
from .http_client import FetchResult, read_fixture, request_with_retry
from .parsers import parse_hsbc_all_funds_csv
from .repository import upsert_hsbc_prices
from .settings import Settings
from .stats import _date_chunks, _new_stats, _note_changed_date


def fetch_hsbc_all_funds_csv(
    *,
    from_date: date,
    to_date: date,
    timeout_seconds: float,
    retries: int,
    backoff_seconds: float,
    use_fixtures: bool,
    fixture_dir: Path | None,
) -> FetchResult:
    if use_fixtures:
        payload = read_fixture(fixture_dir=fixture_dir, filename="hsbc_all_supertrust_20260901_20261007.csv")
        return {"source": "hsbc.fixture", "payload": payload, "status_code": 200, "fetched_at": "fixture"}

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


def crawl(
    *, from_date: date, to_date: date, settings: Settings
) -> dict[str, Any]:
    """Crawl HSBC CSV data and upsert parsed prices.

    Args:
        from_date: Inclusive crawl window start date.
        to_date: Inclusive crawl window end date.
        settings: Process settings including fixture toggles and fixture path.

    Returns:
        Stats map for HSBC processing only.
    """
    stats = _new_stats()
    for chunk_from, chunk_to in _date_chunks(from_date, to_date, chunk_days=28):
        fetch_result = fetch_hsbc_all_funds_csv(
            from_date=chunk_from,
            to_date=chunk_to,
            timeout_seconds=30.0,
            retries=3,
            backoff_seconds=1.5,
            use_fixtures=settings.crawler_use_fixtures,
            fixture_dir=settings.crawler_fixture_dir,
        )
        records = parse_hsbc_all_funds_csv(fetch_result["payload"])
        stats["funds_seen"] += len({item.fund_name for item in records})
        with begin_connection() as connection:
            upsert_stats = upsert_hsbc_prices(connection, records)
        stats["price_rows_inserted"] += upsert_stats["inserted"]
        stats["price_rows_updated"] += upsert_stats["updated"]
        stats["price_rows_unchanged"] += upsert_stats["unchanged"]
        if upsert_stats["min_changed_date"]:
            _note_changed_date(stats, upsert_stats["min_changed_date"])
        if upsert_stats["max_changed_date"]:
            _note_changed_date(stats, upsert_stats["max_changed_date"])
    return stats
