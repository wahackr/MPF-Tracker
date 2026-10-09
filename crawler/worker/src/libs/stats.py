from __future__ import annotations

from collections.abc import Iterable
from datetime import date, timedelta
from typing import Any

def _new_stats() -> dict[str, Any]:
    """Create a zeroed mutable stats structure for crawl aggregation.

    Returns:
        Dict containing counters, changed-date boundaries, and failure list.
    """
    return {
        "funds_seen": 0,
        "price_rows_inserted": 0,
        "price_rows_updated": 0,
        "price_rows_unchanged": 0,
        "changed_from_date": None,
        "changed_to_date": None,
        "funds_failed": [],
    }


def _note_changed_date(stats: dict[str, Any], changed_date: date) -> None:
    """Update changed-date boundaries with one changed price date.

    Args:
        stats: Mutable stats map.
        changed_date: Date that inserted/updated data changed.
    """
    if stats["changed_from_date"] is None or changed_date < stats["changed_from_date"]:
        stats["changed_from_date"] = changed_date
    if stats["changed_to_date"] is None or changed_date > stats["changed_to_date"]:
        stats["changed_to_date"] = changed_date


def _note_price_write(
    stats: dict[str, Any], *, inserted: bool, changed: bool, changed_date: date
) -> None:
    """Record one write outcome in stats.

    Args:
        stats: Mutable stats map.
        inserted: True when the row was newly inserted.
        changed: True when row content changed (insert or update).
        changed_date: Price date associated with the write.
    """
    if not changed:
        stats["price_rows_unchanged"] += 1
        return
    if inserted:
        stats["price_rows_inserted"] += 1
    else:
        stats["price_rows_updated"] += 1
    _note_changed_date(stats, changed_date)


def _merge_stats(target: dict[str, Any], source: dict[str, Any]) -> None:
    """Merge one provider stats map into the run-level stats map.

    Args:
        target: Aggregate stats map to mutate.
        source: Provider-level stats map to merge.
    """
    target["funds_seen"] += source["funds_seen"]
    target["price_rows_inserted"] += source["price_rows_inserted"]
    target["price_rows_updated"] += source["price_rows_updated"]
    target["price_rows_unchanged"] += source["price_rows_unchanged"]
    if source["changed_from_date"]:
        _note_changed_date(target, source["changed_from_date"])
    if source["changed_to_date"]:
        _note_changed_date(target, source["changed_to_date"])
    target["funds_failed"].extend(source["funds_failed"])


def _date_chunks(
    from_date: date, to_date: date, *, chunk_days: int
) -> Iterable[tuple[date, date]]:
    """Yield inclusive date chunks for bounded provider requests.

    Args:
        from_date: Inclusive range start.
        to_date: Inclusive range end.
        chunk_days: Maximum number of days per yielded chunk.

    Yields:
        Tuples of ``(chunk_from, chunk_to)`` with inclusive boundaries.
    """
    current = from_date
    while current <= to_date:
        current_end = min(current + timedelta(days=chunk_days - 1), to_date)
        yield (current, current_end)
        current = current_end + timedelta(days=1)
