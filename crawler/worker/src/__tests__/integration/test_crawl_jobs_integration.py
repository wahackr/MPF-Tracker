from __future__ import annotations

from contextlib import contextmanager
from datetime import date
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src import main as crawl_jobs  # type: ignore[import-not-found]
from src.libs import hsbc, manulife, stats as crawl_stats  # type: ignore[import-not-found]


def _settings() -> SimpleNamespace:
    return SimpleNamespace(crawler_use_fixtures=False, crawler_fixture_dir=Path("/tmp/fixtures"))


@contextmanager
def _fake_connection():
    yield object()


def test_run_crawl_dispatches_hsbc_and_creates_invalidation(monkeypatch: pytest.MonkeyPatch) -> None:
    hsbc_stats = {
        "funds_seen": 2,
        "price_rows_inserted": 1,
        "price_rows_updated": 0,
        "price_rows_unchanged": 0,
        "changed_from_date": date(2026, 10, 1),
        "changed_to_date": date(2026, 10, 7),
        "funds_failed": [],
    }
    monkeypatch.setattr(crawl_jobs, "_crawl_hsbc", lambda **_kwargs: hsbc_stats)
    monkeypatch.setattr(crawl_jobs, "_crawl_manulife", lambda **_kwargs: pytest.fail("manulife should not run"))
    monkeypatch.setattr(crawl_jobs, "begin_connection", _fake_connection)
    invalidations: list[dict[str, object]] = []
    monkeypatch.setattr(
        crawl_jobs,
        "create_snapshot_invalidation_request",
        lambda _conn, **kwargs: invalidations.append(kwargs),
    )

    result = crawl_jobs._run_crawl(
        provider="hsbc",
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        manulife_filter_days=None,
        mode="sync",
        settings=_settings(),
    )

    assert result["providers"] == ["hsbc"]
    assert result["price_rows_inserted"] == 1
    assert result["changed_from_date"] == "2026-10-01"
    assert result["changed_to_date"] == "2026-10-07"
    assert len(invalidations) == 1
    assert invalidations[0]["reason"] == "crawler_sync"


def test_run_crawl_dispatches_both_providers_for_all(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        crawl_jobs,
        "_crawl_hsbc",
        lambda **_kwargs: {
            "funds_seen": 1,
            "price_rows_inserted": 1,
            "price_rows_updated": 0,
            "price_rows_unchanged": 0,
            "changed_from_date": date(2026, 10, 1),
            "changed_to_date": date(2026, 10, 1),
            "funds_failed": [],
        },
    )
    monkeypatch.setattr(
        crawl_jobs,
        "_crawl_manulife",
        lambda **_kwargs: {
            "funds_seen": 1,
            "price_rows_inserted": 0,
            "price_rows_updated": 1,
            "price_rows_unchanged": 0,
            "changed_from_date": date(2026, 10, 2),
            "changed_to_date": date(2026, 10, 2),
            "funds_failed": [{"fund_id": "manulife:ABC", "error": "x", "note": "y"}],
        },
    )
    monkeypatch.setattr(crawl_jobs, "begin_connection", _fake_connection)
    monkeypatch.setattr(crawl_jobs, "create_snapshot_invalidation_request", lambda *_args, **_kwargs: None)

    result = crawl_jobs._run_crawl(
        provider="all",
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        manulife_filter_days=7,
        mode="backfill",
        settings=_settings(),
    )

    assert result["providers"] == ["hsbc", "manulife"]
    assert result["funds_seen"] == 2
    assert result["price_rows_inserted"] == 1
    assert result["price_rows_updated"] == 1
    assert result["changed_from_date"] == "2026-10-01"
    assert result["changed_to_date"] == "2026-10-02"
    assert len(result["funds_failed"]) == 1


def test_run_crawl_rejects_invalid_provider() -> None:
    with pytest.raises(ValueError, match="provider must be one of"):
        crawl_jobs._run_crawl(
            provider="BAD",
            from_date=date(2026, 10, 1),
            to_date=date(2026, 10, 7),
            manulife_filter_days=None,
            mode="sync",
            settings=_settings(),
        )


def test_process_sync_job_validates_rolling_days(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(crawl_jobs, "get_settings", _settings)

    with pytest.raises(ValueError, match="rolling_days must be between 1 and 28"):
        crawl_jobs.process_sync_job({"provider": "hsbc", "rolling_days": 0})


def test_process_backfill_job_validates_dates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(crawl_jobs, "get_settings", _settings)

    with pytest.raises(ValueError, match="from_date and to_date are required for backfill"):
        crawl_jobs.process_backfill_job({"provider": "hsbc"})

    with pytest.raises(ValueError, match="from_date must be <="):
        crawl_jobs.process_backfill_job(
            {"provider": "hsbc", "from_date": "2026-10-07", "to_date": "2026-10-01"}
        )


def test_crawl_hsbc_aggregates_upsert_stats(monkeypatch: pytest.MonkeyPatch) -> None:
    record_a = SimpleNamespace(fund_name="Fund A")
    record_b = SimpleNamespace(fund_name="Fund B")
    monkeypatch.setattr(hsbc, "_date_chunks", lambda *_args, **_kwargs: [(date(2026, 10, 1), date(2026, 10, 7))])
    monkeypatch.setattr(hsbc, "fetch_hsbc_all_funds_csv", lambda **_kwargs: {"payload": "csv"})
    monkeypatch.setattr(hsbc, "parse_hsbc_all_funds_csv", lambda _payload: [record_a, record_b])
    monkeypatch.setattr(hsbc, "begin_connection", _fake_connection)
    monkeypatch.setattr(
        hsbc,
        "upsert_hsbc_prices",
        lambda _conn, _records: {
            "inserted": 2,
            "updated": 1,
            "unchanged": 3,
            "min_changed_date": date(2026, 10, 1),
            "max_changed_date": date(2026, 10, 7),
        },
    )

    stats = hsbc.crawl(from_date=date(2026, 10, 1), to_date=date(2026, 10, 7), settings=_settings())

    assert stats["funds_seen"] == 2
    assert stats["price_rows_inserted"] == 2
    assert stats["price_rows_updated"] == 1
    assert stats["price_rows_unchanged"] == 3
    assert stats["changed_from_date"] == date(2026, 10, 1)
    assert stats["changed_to_date"] == date(2026, 10, 7)


def test_crawl_manulife_writes_nav_and_calls_backfill_in_backfill_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fund_regular = SimpleNamespace(
        fund_id="SHK122",
        nav_as_of_date=date(2026, 10, 7),
        nav_price=10,
        interest_fund_flag=False,
    )
    fund_interest_zero = SimpleNamespace(
        fund_id="DHK121",
        nav_as_of_date=date(2026, 10, 7),
        nav_price=0,
        interest_fund_flag=True,
    )
    monkeypatch.setattr(manulife, "fetch_manulife_fundslist", lambda **_kwargs: {"payload": "json"})
    monkeypatch.setattr(manulife, "parse_manulife_fundslist", lambda _payload: [fund_regular, fund_interest_zero])
    monkeypatch.setattr(manulife, "begin_connection", _fake_connection)
    monkeypatch.setattr(manulife, "upsert_manulife_fund", lambda _conn, fund: f"manulife:{fund.fund_id}")
    nav_writes: list[dict[str, object]] = []
    monkeypatch.setattr(
        manulife,
        "upsert_manulife_nav_price",
        lambda _conn, **kwargs: nav_writes.append(kwargs) or (True, True),
    )
    backfill_calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        manulife,
        "_crawl_manulife_history",
        lambda **kwargs: backfill_calls.append(kwargs),
    )

    stats = manulife.crawl(
        mode="backfill",
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        manulife_filter_days=14,
        settings=_settings(),
    )

    assert stats["funds_seen"] == 2
    assert stats["price_rows_inserted"] == 1
    assert stats["price_rows_updated"] == 0
    assert len(nav_writes) == 1
    assert nav_writes[0]["source"] == "manulife_fundslist"
    assert len(backfill_calls) == 1


class _FakeFuture:
    def __init__(self, *, result=None, error: Exception | None = None) -> None:
        self._result = result
        self._error = error

    def result(self):
        if self._error is not None:
            raise self._error
        return self._result


class _FakeExecutor:
    def __init__(self, *args, **kwargs) -> None:
        self.futures: list[_FakeFuture] = []

    def __enter__(self) -> _FakeExecutor:
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def submit(self, fn, *args):
        try:
            value = fn(*args)
            future = _FakeFuture(result=value)
        except Exception as exc:
            future = _FakeFuture(error=exc)
        self.futures.append(future)
        return future


def test_crawl_manulife_history_handles_failures_filters_and_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stats = manulife._new_stats()
    monkeypatch.setattr(manulife, "begin_connection", _fake_connection)
    monkeypatch.setattr(manulife, "list_manulife_fund_ids", lambda _conn: ["manulife:A", "manulife:B"])

    def _fetch_for_fund(fund_id: str, _settings: SimpleNamespace):
        if fund_id.endswith("B"):
            raise ValueError("blocked")
        return [
            SimpleNamespace(price_date=date(2026, 10, 1), nav=10),
            SimpleNamespace(price_date=date(2026, 9, 20), nav=9),
            SimpleNamespace(price_date=date(2026, 10, 9), nav=11),
        ]

    monkeypatch.setattr(manulife, "_fetch_history_points_for_fund", _fetch_for_fund)
    monkeypatch.setattr(manulife, "ThreadPoolExecutor", _FakeExecutor)
    monkeypatch.setattr(manulife, "as_completed", lambda futures: list(futures))

    writes: list[dict[str, object]] = []
    monkeypatch.setattr(
        manulife,
        "upsert_manulife_nav_price",
        lambda _conn, **kwargs: writes.append(kwargs) or (True, True),
    )

    manulife._crawl_manulife_history(
        stats=stats,
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        manulife_filter_days=14,
        settings=_settings(),
    )

    assert len(writes) == 1
    assert writes[0]["fund_id"] == "manulife:A"
    assert writes[0]["price_date"] == date(2026, 10, 1)
    assert writes[0]["source"] == "manulife_fundhistory"
    assert len(stats["funds_failed"]) == 1
    assert stats["funds_failed"][0]["fund_id"] == "manulife:B"
    assert stats["funds_failed"][0]["note"] == "fundhistory_unverified_or_blocked"


def test_helper_functions_cover_stats_dates_and_parse_paths() -> None:
    stats = crawl_stats._new_stats()
    crawl_stats._note_price_write(stats, inserted=True, changed=True, changed_date=date(2026, 10, 3))
    crawl_stats._note_price_write(stats, inserted=False, changed=True, changed_date=date(2026, 10, 4))
    crawl_stats._note_price_write(stats, inserted=False, changed=False, changed_date=date(2026, 10, 5))

    assert stats["price_rows_inserted"] == 1
    assert stats["price_rows_updated"] == 1
    assert stats["price_rows_unchanged"] == 1
    assert stats["changed_from_date"] == date(2026, 10, 3)
    assert stats["changed_to_date"] == date(2026, 10, 4)

    target = crawl_stats._new_stats()
    source = {
        "funds_seen": 3,
        "price_rows_inserted": 2,
        "price_rows_updated": 1,
        "price_rows_unchanged": 4,
        "changed_from_date": date(2026, 10, 1),
        "changed_to_date": date(2026, 10, 6),
        "funds_failed": [{"fund_id": "x"}],
    }
    crawl_stats._merge_stats(target, source)
    assert target["funds_seen"] == 3
    assert target["changed_from_date"] == date(2026, 10, 1)
    assert target["changed_to_date"] == date(2026, 10, 6)
    assert target["funds_failed"] == [{"fund_id": "x"}]

    chunks = list(crawl_stats._date_chunks(date(2026, 10, 1), date(2026, 10, 5), chunk_days=2))
    assert chunks == [
        (date(2026, 10, 1), date(2026, 10, 2)),
        (date(2026, 10, 3), date(2026, 10, 4)),
        (date(2026, 10, 5), date(2026, 10, 5)),
    ]

    assert crawl_jobs._parse_date(date(2026, 10, 1)) == date(2026, 10, 1)
    assert crawl_jobs._parse_date("2026-10-01") == date(2026, 10, 1)
    assert crawl_jobs._parse_date("bad-date") is None
    assert crawl_jobs._parse_date(12345) is None


def test_fetch_history_points_for_fund_uses_provider_code_from_db_fund_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        manulife,
        "fetch_manulife_fundhistory",
        lambda **kwargs: {"payload": f"id={kwargs['fund_id']}"},
    )
    monkeypatch.setattr(manulife, "parse_manulife_fundhistory", lambda payload: [payload])

    parsed = manulife._fetch_history_points_for_fund("manulife:SHK122", _settings())
    assert parsed == ["id=SHK122"]
