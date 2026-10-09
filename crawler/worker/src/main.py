from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .libs.db import begin_connection
from .libs.invalidation import create_snapshot_invalidation_request
from .libs.settings import Settings, get_settings
from .libs.hsbc import crawl as _crawl_hsbc
from .libs.manulife import crawl as _crawl_manulife
from .libs.stats import _new_stats, _merge_stats

PROVIDER_ALL = "all"
PROVIDER_HSBC = "hsbc"
PROVIDER_MANULIFE = "manulife"
VALID_PROVIDERS = {PROVIDER_ALL, PROVIDER_HSBC, PROVIDER_MANULIFE}


def process_sync_job(payload: dict[str, Any]) -> dict[str, Any]:
    """Run a rolling-window crawl job.

    Args:
        payload: Job request payload from ``mpf.jobs.request``.
            Required keys:
                - provider: ``"all"``, ``"hsbc"``, or ``"manulife"``
            Optional keys:
                - rolling_days: integer window size (default 7, allowed 1..28)

    Returns:
        Aggregated crawl result including provider list, write counts,
        changed date range, and per-fund failure entries.

    Raises:
        KeyError: If ``provider`` is missing from payload.
        ValueError: If provider is invalid or ``rolling_days`` is out of range.
    """
    settings = get_settings()
    provider = payload["provider"]
    rolling_days = int(payload.get("rolling_days", 7))
    if rolling_days < 1 or rolling_days > 28:
        raise ValueError("rolling_days must be between 1 and 28")

    today = datetime.now(tz=ZoneInfo("Asia/Hong_Kong")).date()
    from_date = today - timedelta(days=rolling_days - 1)
    to_date = today

    return _run_crawl(
        provider=provider,
        from_date=from_date,
        to_date=to_date,
        manulife_filter_days=None,
        mode="sync",
        settings=settings,
    )


def process_backfill_job(payload: dict[str, Any]) -> dict[str, Any]:
    """Run a fixed-date-range backfill crawl job.

    Args:
        payload: Job request payload from ``mpf.jobs.request``.
            Required keys:
                - provider: ``"all"``, ``"hsbc"``, or ``"manulife"``
                - from_date: ``YYYY-MM-DD``
                - to_date: ``YYYY-MM-DD``
            Optional keys:
                - manulife_filter_days: positive integer recency cap for
                  Manulife fundhistory points.

    Returns:
        Aggregated crawl result including provider list, write counts,
        changed date range, and per-fund failure entries.

    Raises:
        KeyError: If ``provider`` is missing from payload.
        ValueError: If provider is invalid, dates are missing/unparseable,
            or ``from_date`` is greater than ``to_date``.
    """
    settings = get_settings()
    provider = payload["provider"]
    from_date = _parse_date(payload.get("from_date"))
    to_date = _parse_date(payload.get("to_date"))
    if from_date is None or to_date is None:
        raise ValueError("from_date and to_date are required for backfill")
    if from_date > to_date:
        raise ValueError("from_date must be <= to_date")

    filter_days_raw = payload.get("manulife_filter_days")
    manulife_filter_days = int(filter_days_raw) if filter_days_raw is not None else None

    return _run_crawl(
        provider=provider,
        from_date=from_date,
        to_date=to_date,
        manulife_filter_days=manulife_filter_days,
        mode="backfill",
        settings=settings,
    )


def _run_crawl(
    *,
    provider: str,
    from_date: date,
    to_date: date,
    manulife_filter_days: int | None,
    mode: str,
    settings: Settings,
) -> dict[str, Any]:
    """Execute the crawler pipeline for selected provider scope.

    The flow is:
    1) fetch provider payloads
    2) parse payloads
    3) ensure fund identities
    4) upsert price rows
    5) aggregate stats and enqueue snapshot invalidation when data changed

    Args:
        provider: Exact provider selector (``all``/``hsbc``/``manulife``).
        from_date: Inclusive crawl window start date.
        to_date: Inclusive crawl window end date.
        manulife_filter_days: Optional recency cutoff for Manulife history.
        mode: Job mode string (``sync`` or ``backfill``) used for reason tags.
        settings: Process settings (fixtures, paths, worker config).

    Returns:
        Aggregated crawl result including provider list, write counts,
        changed date range, and per-fund failure entries.

    Raises:
        ValueError: If provider is not exactly one of the allowed values.
    """
    if provider == PROVIDER_HSBC:
        providers = [PROVIDER_HSBC]
    elif provider == PROVIDER_MANULIFE:
        providers = [PROVIDER_MANULIFE]
    elif provider == PROVIDER_ALL:
        providers = [PROVIDER_HSBC, PROVIDER_MANULIFE]
    else:
        raise ValueError(f"provider must be one of: {', '.join(sorted(VALID_PROVIDERS))}")
    stats = _new_stats()

    if PROVIDER_HSBC in providers:
        _merge_stats(
            stats, _crawl_hsbc(from_date=from_date, to_date=to_date, settings=settings)
        )
    if PROVIDER_MANULIFE in providers:
        _merge_stats(
            stats,
            _crawl_manulife(
                mode=mode,
                from_date=from_date,
                to_date=to_date,
                manulife_filter_days=manulife_filter_days,
                settings=settings,
            ),
        )

    if stats["changed_from_date"]:
        with begin_connection() as connection:
            create_snapshot_invalidation_request(
                connection,
                source_service="crawler",
                reason=f"crawler_{mode}",
                from_date=stats["changed_from_date"],
                to_date=stats["changed_to_date"],
            )

    return {
        "providers": providers,
        "funds_seen": stats["funds_seen"],
        "price_rows_inserted": stats["price_rows_inserted"],
        "price_rows_updated": stats["price_rows_updated"],
        "price_rows_unchanged": stats["price_rows_unchanged"],
        "changed_from_date": (
            stats["changed_from_date"].isoformat()
            if stats["changed_from_date"]
            else None
        ),
        "changed_to_date": (
            stats["changed_to_date"].isoformat() if stats["changed_to_date"] else None
        ),
        "funds_failed": stats["funds_failed"],
    }


def _parse_date(value: Any) -> date | None:
    """Parse an ISO date string into ``date``.

    Args:
        value: Raw value that may be a ``date`` or ``YYYY-MM-DD`` string.

    Returns:
        Parsed date on success, otherwise ``None``.
    """
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None
