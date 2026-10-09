from __future__ import annotations

from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from shared.db import begin_connection
from shared.settings import get_settings

from services.crawler.app.invalidation import create_snapshot_invalidation_request
from services.crawler.app.parsers import (
    ParseError,
    parse_hsbc_all_funds_csv,
    parse_manulife_fundhistory,
    parse_manulife_fundslist,
)
from services.crawler.app.provider_clients import CrawlerHttpClient, ProviderHttpError
from services.crawler.app.repository import (
    list_manulife_fund_ids,
    upsert_hsbc_prices,
    upsert_manulife_fund,
    upsert_manulife_nav_price,
)
from services.crawler.app.schemas import Provider


@dataclass
class CrawlerRunStats:
    funds_seen: int = 0
    price_rows_inserted: int = 0
    price_rows_updated: int = 0
    price_rows_unchanged: int = 0
    changed_from_date: date | None = None
    changed_to_date: date | None = None
    funds_failed: list[dict[str, str]] | None = None

    def __post_init__(self) -> None:
        if self.funds_failed is None:
            self.funds_failed = []

    def note_changed_date(self, changed_date: date) -> None:
        if self.changed_from_date is None or changed_date < self.changed_from_date:
            self.changed_from_date = changed_date
        if self.changed_to_date is None or changed_date > self.changed_to_date:
            self.changed_to_date = changed_date


def build_job_handlers() -> dict[str, Any]:
    settings = get_settings()
    fixture_dir = Path("/app/mpf-codex-handoff/fixtures")
    client = CrawlerHttpClient(
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
        use_fixtures=bool(getattr(settings, "crawler_use_fixtures", False)),
        fixture_dir=fixture_dir,
    )
    return {
        "sync": lambda payload: process_sync_job(payload=payload, client=client),
        "backfill": lambda payload: process_backfill_job(payload=payload, client=client),
    }


def process_sync_job(*, payload: dict[str, Any], client: CrawlerHttpClient) -> dict[str, Any]:
    provider = Provider(payload.get("provider", Provider.ALL.value))
    rolling_days = int(payload.get("rolling_days", 7))
    if rolling_days < 1 or rolling_days > 28:
        raise ValueError("rolling_days must be between 1 and 28")

    today = datetime.now(tz=ZoneInfo("Asia/Hong_Kong")).date()
    from_date = today - timedelta(days=rolling_days - 1)
    to_date = today

    results = _run_crawl(
        provider=provider,
        client=client,
        from_date=from_date,
        to_date=to_date,
        manulife_filter_days=None,
        mode="sync",
    )
    return results


def process_backfill_job(*, payload: dict[str, Any], client: CrawlerHttpClient) -> dict[str, Any]:
    provider = Provider(payload.get("provider", Provider.ALL.value))
    from_date = _parse_date(payload.get("from_date"))
    to_date = _parse_date(payload.get("to_date"))
    if from_date is None or to_date is None:
        raise ValueError("from_date and to_date are required for backfill")
    if from_date > to_date:
        raise ValueError("from_date must be <= to_date")
    filter_days = None

    results = _run_crawl(
        provider=provider,
        client=client,
        from_date=from_date,
        to_date=to_date,
        manulife_filter_days=filter_days,
        mode="backfill",
    )
    return results


def _run_crawl(
    *,
    provider: Provider,
    client: CrawlerHttpClient,
    from_date: date,
    to_date: date,
    manulife_filter_days: int | None,
    mode: str,
) -> dict[str, Any]:
    providers = [provider.value] if provider != Provider.ALL else [Provider.HSBC.value, Provider.MANULIFE.value]
    stats = CrawlerRunStats()

    if Provider.HSBC.value in providers:
        hsbc_stats = _crawl_hsbc(client=client, from_date=from_date, to_date=to_date)
        _merge_stats(stats, hsbc_stats)

    if Provider.MANULIFE.value in providers:
        manulife_stats = _crawl_manulife(
            client=client,
            mode=mode,
            from_date=from_date,
            to_date=to_date,
            manulife_filter_days=manulife_filter_days,
        )
        _merge_stats(stats, manulife_stats)

    if stats.changed_from_date:
        with begin_connection() as connection:
            create_snapshot_invalidation_request(
                connection,
                source_service="crawler",
                reason=f"crawler_{mode}",
                from_date=stats.changed_from_date,
                to_date=stats.changed_to_date,
            )

    return {
        "providers": providers,
        "funds_seen": stats.funds_seen,
        "price_rows_inserted": stats.price_rows_inserted,
        "price_rows_updated": stats.price_rows_updated,
        "price_rows_unchanged": stats.price_rows_unchanged,
        "changed_from_date": stats.changed_from_date.isoformat() if stats.changed_from_date else None,
        "changed_to_date": stats.changed_to_date.isoformat() if stats.changed_to_date else None,
        "funds_failed": stats.funds_failed,
    }


def _crawl_hsbc(*, client: CrawlerHttpClient, from_date: date, to_date: date) -> CrawlerRunStats:
    stats = CrawlerRunStats()
    for chunk_from, chunk_to in _date_chunks(from_date, to_date, chunk_days=28):
        result = client.fetch_hsbc_all_funds_csv(from_date=chunk_from, to_date=chunk_to)
        records = parse_hsbc_all_funds_csv(result.payload)
        unique_funds = {item.fund_name for item in records}
        stats.funds_seen += len(unique_funds)
        with begin_connection() as connection:
            upsert_stats = upsert_hsbc_prices(connection, records)
        stats.price_rows_inserted += upsert_stats.inserted
        stats.price_rows_updated += upsert_stats.updated
        stats.price_rows_unchanged += upsert_stats.unchanged
        if upsert_stats.min_changed_date:
            stats.note_changed_date(upsert_stats.min_changed_date)
        if upsert_stats.max_changed_date:
            stats.note_changed_date(upsert_stats.max_changed_date)
    return stats


def _crawl_manulife(
    *,
    client: CrawlerHttpClient,
    mode: str,
    from_date: date,
    to_date: date,
    manulife_filter_days: int | None,
) -> CrawlerRunStats:
    stats = CrawlerRunStats()
    result = client.fetch_manulife_fundslist()
    funds = parse_manulife_fundslist(result.payload)
    stats.funds_seen += len(funds)

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
                if changed:
                    if inserted:
                        stats.price_rows_inserted += 1
                    else:
                        stats.price_rows_updated += 1
                    stats.note_changed_date(fund.nav_as_of_date)
                else:
                    stats.price_rows_unchanged += 1

    if mode == "backfill":
        _crawl_manulife_history(
            client=client,
            stats=stats,
            from_date=from_date,
            to_date=to_date,
            manulife_filter_days=manulife_filter_days,
        )
    return stats


def _crawl_manulife_history(
    *,
    client: CrawlerHttpClient,
    stats: CrawlerRunStats,
    from_date: date,
    to_date: date,
    manulife_filter_days: int | None,
) -> None:
    with begin_connection() as connection:
        fund_ids = list_manulife_fund_ids(connection)

    if manulife_filter_days is not None and manulife_filter_days > 0:
        min_allowed_date = datetime.now(tz=ZoneInfo("Asia/Hong_Kong")).date() - timedelta(days=manulife_filter_days - 1)
    else:
        min_allowed_date = None

    with ThreadPoolExecutor(max_workers=3) as executor:
        future_map = {
            executor.submit(_fetch_history_points_for_fund, client, db_fund_id): db_fund_id for db_fund_id in fund_ids
        }
        for future in as_completed(future_map):
            db_fund_id = future_map[future]
            try:
                history_points = future.result()
            except (ProviderHttpError, ParseError, ValueError) as exc:
                stats.funds_failed.append(
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
                if changed:
                    if inserted:
                        stats.price_rows_inserted += 1
                    else:
                        stats.price_rows_updated += 1
                    stats.note_changed_date(point.price_date)
                else:
                    stats.price_rows_unchanged += 1


def _merge_stats(target: CrawlerRunStats, source: CrawlerRunStats) -> None:
    target.funds_seen += source.funds_seen
    target.price_rows_inserted += source.price_rows_inserted
    target.price_rows_updated += source.price_rows_updated
    target.price_rows_unchanged += source.price_rows_unchanged
    if source.changed_from_date:
        target.note_changed_date(source.changed_from_date)
    if source.changed_to_date:
        target.note_changed_date(source.changed_to_date)
    target.funds_failed.extend(source.funds_failed or [])


def _date_chunks(from_date: date, to_date: date, *, chunk_days: int) -> Iterable[tuple[date, date]]:
    current = from_date
    while current <= to_date:
        current_end = min(current + timedelta(days=chunk_days - 1), to_date)
        yield (current, current_end)
        current = current_end + timedelta(days=1)


def _parse_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def _fetch_history_points_for_fund(client: CrawlerHttpClient, db_fund_id: str):
    provider_code = db_fund_id.split(":", 1)[1] if ":" in db_fund_id else db_fund_id
    result = client.fetch_manulife_fundhistory(fund_id=provider_code)
    return parse_manulife_fundhistory(result.payload)
