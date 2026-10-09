from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .db import begin_connection
from .http_client import FetchResult, ProviderHttpError, read_fixture, request_with_retry
from .parsers import FundHistoryPoint, ParseError, parse_manulife_fundhistory, parse_manulife_fundslist
from .repository import list_manulife_fund_ids, upsert_manulife_fund, upsert_manulife_nav_price
from .settings import Settings
from .stats import _new_stats, _note_price_write


def fetch_manulife_fundslist(
    *,
    timeout_seconds: float,
    retries: int,
    backoff_seconds: float,
    use_fixtures: bool,
    fixture_dir: Path | None,
) -> FetchResult:
    if use_fixtures:
        payload = read_fixture(fixture_dir=fixture_dir, filename="manulife_fundslist.json")
        return {
            "source": "manulife.fixture.fundslist",
            "payload": payload,
            "status_code": 200,
            "fetched_at": "fixture",
        }

    response = request_with_retry(
        timeout_seconds=timeout_seconds,
        retries=retries,
        backoff_seconds=backoff_seconds,
        method="GET",
        url="https://scmpf.manulife.com.hk/bin/funds/fundslist",
        params={"productLine": "mpf", "overrideLocale": "en_HK"},
        headers=_manulife_headers(),
    )
    return {
        "source": "manulife.fundslist",
        "payload": response.text,
        "status_code": response.status_code,
        "fetched_at": response.headers.get("date", ""),
    }


def fetch_manulife_fundhistory(
    *,
    fund_id: str,
    timeout_seconds: float,
    retries: int,
    backoff_seconds: float,
    use_fixtures: bool,
    fixture_dir: Path | None,
) -> FetchResult:
    if use_fixtures:
        filename = f"manulife_fundhistory_{fund_id}.json"
        payload = read_fixture(fixture_dir=fixture_dir, filename=filename, required=False)
        if payload is None:
            raise ProviderHttpError(
                f"Missing fixture: {filename}. Real API fixture still unverified/blocked."
            )
        return {
            "source": "manulife.fixture.fundhistory",
            "payload": payload,
            "status_code": 200,
            "fetched_at": "fixture",
        }

    response = request_with_retry(
        timeout_seconds=timeout_seconds,
        retries=retries,
        backoff_seconds=backoff_seconds,
        method="GET",
        url="https://scmpf.manulife.com.hk/bin/funds/fundhistory",
        params={"id": fund_id, "productLine": "mpf", "overrideLocale": "en_HK"},
        headers=_manulife_headers(),
    )
    return {
        "source": "manulife.fundhistory",
        "payload": response.text,
        "status_code": response.status_code,
        "fetched_at": response.headers.get("date", ""),
    }


def _manulife_headers() -> dict[str, str]:
    return {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/154.0.0.0 Safari/537.36"
        ),
    }


def crawl(
    *,
    mode: str,
    from_date: date,
    to_date: date,
    manulife_filter_days: int | None,
    settings: Settings,
) -> dict[str, Any]:
    """Crawl Manulife funds list and optional history.

    Args:
        mode: Job mode string. ``backfill`` enables fundhistory crawl.
        from_date: Inclusive crawl window start date.
        to_date: Inclusive crawl window end date.
        manulife_filter_days: Optional recency cutoff for history points.
        settings: Process settings including fixture toggles and fixture path.

    Returns:
        Stats map for Manulife processing only.
    """
    stats = _new_stats()
    fetch_result = fetch_manulife_fundslist(
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
        use_fixtures=settings.crawler_use_fixtures,
        fixture_dir=settings.crawler_fixture_dir,
    )
    funds = parse_manulife_fundslist(fetch_result["payload"])
    stats["funds_seen"] += len(funds)

    with begin_connection() as connection:
        for fund in funds:
            db_fund_id = upsert_manulife_fund(connection, fund)
            if fund.nav_as_of_date and fund.nav_price is not None:
                if fund.interest_fund_flag and fund.nav_price == Decimal("0"):
                    continue
                inserted, changed = upsert_manulife_nav_price(
                    connection,
                    fund_id=db_fund_id,
                    price_date=fund.nav_as_of_date,
                    nav=fund.nav_price,
                    source="manulife_fundslist",
                )
                _note_price_write(
                    stats,
                    inserted=inserted,
                    changed=changed,
                    changed_date=fund.nav_as_of_date,
                )

    if mode == "backfill":
        _crawl_manulife_history(
            stats=stats,
            from_date=from_date,
            to_date=to_date,
            manulife_filter_days=manulife_filter_days,
            settings=settings,
        )
    return stats


def _crawl_manulife_history(
    *,
    stats: dict[str, Any],
    from_date: date,
    to_date: date,
    manulife_filter_days: int | None,
    settings: Settings,
) -> None:
    """Fetch per-fund Manulife history and upsert eligible price points.

    Args:
        stats: Mutable run stats map to update with write counts/failures.
        from_date: Inclusive crawl window start date.
        to_date: Inclusive crawl window end date.
        manulife_filter_days: Optional recency cutoff for history points.
        settings: Process settings including fixture toggles and fixture path.
    """
    with begin_connection() as connection:
        fund_ids = list_manulife_fund_ids(connection)

    min_allowed_date: date | None = None
    if manulife_filter_days is not None and manulife_filter_days > 0:
        min_allowed_date = datetime.now(
            tz=ZoneInfo("Asia/Hong_Kong")
        ).date() - timedelta(days=manulife_filter_days - 1)

    with ThreadPoolExecutor(max_workers=3) as executor:
        future_map = {
            executor.submit(_fetch_history_points_for_fund, fund_id, settings): fund_id
            for fund_id in fund_ids
        }
        for future in as_completed(future_map):
            db_fund_id = future_map[future]
            try:
                history_points = future.result()
            except (ProviderHttpError, ParseError, ValueError) as exc:
                stats["funds_failed"].append(
                    {
                        "fund_id": db_fund_id,
                        "error": str(exc),
                        "note": "fundhistory_unverified_or_blocked",
                    }
                )
                continue

            for point in history_points:
                if point.price_date < from_date or point.price_date > to_date:
                    continue
                if min_allowed_date and point.price_date < min_allowed_date:
                    continue
                with begin_connection() as connection:
                    inserted, changed = upsert_manulife_nav_price(
                        connection,
                        fund_id=db_fund_id,
                        price_date=point.price_date,
                        nav=point.nav,
                        source="manulife_fundhistory",
                    )
                _note_price_write(
                    stats,
                    inserted=inserted,
                    changed=changed,
                    changed_date=point.price_date,
                )


def _fetch_history_points_for_fund(
    db_fund_id: str,
    settings: Settings,
) -> list[FundHistoryPoint]:
    """Fetch and parse Manulife fundhistory for one stored fund id.

    Args:
        db_fund_id: Internal fund id (for example ``manulife:SHK122``).
        settings: Process settings including fixture toggles and fixture path.

    Returns:
        Parsed list of ``FundHistoryPoint`` values.

    Raises:
        ProviderHttpError: If provider fetch fails after retries.
        ParseError: If payload shape/content is invalid.
    """
    provider_code = db_fund_id.split(":", 1)[1] if ":" in db_fund_id else db_fund_id
    result = fetch_manulife_fundhistory(
        fund_id=provider_code,
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
        use_fixtures=settings.crawler_use_fixtures,
        fixture_dir=settings.crawler_fixture_dir,
    )
    return parse_manulife_fundhistory(result["payload"])
