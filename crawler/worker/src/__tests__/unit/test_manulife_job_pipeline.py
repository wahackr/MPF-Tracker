from __future__ import annotations

from contextlib import contextmanager
from datetime import date
from decimal import Decimal
import json
from pathlib import Path
import sys

import httpx
import pytest

WORKER_SRC_DIR = Path(__file__).resolve().parents[2]
if str(WORKER_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC_DIR))

from libs import http_client, jobs
from libs.crawlers import manulife
from libs.crawlers.manulife import (
    ManulifePriceRecord,
    ParseError,
    parse_manulife_fundhistory,
    parse_manulife_fundslist,
)


FIXTURE_DIR = Path(__file__).resolve().parents[5] / "mpf-codex-handoff/fixtures"
CONFIG = object()


class FakeResult:
    def __init__(self, row):
        self.row = row

    def mappings(self):
        return self

    def first(self):
        return self.row


class FakeConnection:
    def __init__(self, rows=None):
        self.rows = iter(rows or [])
        self.price_writes: list[dict] = []

    def execute(self, statement, params):
        assert "INSERT INTO mpf.fund_prices" in str(statement)
        self.price_writes.append(params)
        return FakeResult(next(self.rows))


class FakeEngine:
    def __init__(self, connection=None):
        self.transactions = 0
        self.connection = connection or object()

    @contextmanager
    def begin(self):
        self.transactions += 1
        yield self.connection


def test_manulife_fetches_use_fundslist_then_fundhistory_urls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[dict] = []

    def fake_request(_client, method, url, **kwargs):
        requests.append({"method": method, "url": url, **kwargs})
        return httpx.Response(
            200,
            request=httpx.Request(method, url),
            text="{}",
            headers={"date": "test"},
        )

    monkeypatch.setattr(httpx.Client, "request", fake_request)

    manulife.fetch_manulife_fundslist(
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
    )
    manulife.fetch_manulife_fundhistory(
        fund_id="SHK122",
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
    )

    assert requests[0]["url"] == "https://scmpf.manulife.com.hk/bin/funds/fundslist"
    assert requests[0]["params"] == {
        "productLine": "mpf",
        "overrideLocale": "en_HK",
    }
    assert requests[1]["url"] == "https://scmpf.manulife.com.hk/bin/funds/fundhistory"
    assert requests[1]["params"] == {
        "id": "SHK122",
        "productLine": "mpf",
        "overrideLocale": "en_HK",
    }


def test_verified_shk122_history_fixture_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = (FIXTURE_DIR / "manulife_fundhistory_SHK122.json").read_text(
        encoding="utf-8"
    )

    def fake_request(_client, method, url, **kwargs):
        assert kwargs["params"]["id"] == "SHK122"
        return httpx.Response(200, request=httpx.Request(method, url), text=payload)

    monkeypatch.setattr(httpx.Client, "request", fake_request)

    fetched = manulife.fetch_manulife_fundhistory(
        fund_id="SHK122",
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
    )

    points = parse_manulife_fundhistory(
        fetched["payload"], expected_fund_id="SHK122"
    )

    assert fetched["source"] == "manulife.fundhistory"
    assert [(point.price_date, point.price) for point in points] == [
        (date(2000, 12, 1), Decimal("10.0")),
        (date(2026, 10, 7), Decimal("17.251")),
        (date(2026, 10, 8), Decimal("17.195")),
    ]
    with pytest.raises(ParseError, match="fundId mismatch"):
        parse_manulife_fundhistory(
            fetched["payload"], expected_fund_id="SHK123"
        )


def test_run_job_fetches_parses_and_saves_mocked_http_responses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fundslist = json.loads(
        (FIXTURE_DIR / "manulife_fundslist.json").read_text(encoding="utf-8")
    )
    fund = next(item for item in fundslist if item["fundId"] == "SHK122")
    history = (FIXTURE_DIR / "manulife_fundhistory_SHK122.json").read_text(
        encoding="utf-8"
    )
    requests: list[str] = []
    def fake_request(_client, method, url, **kwargs):
        requests.append(url.rsplit("/", 1)[-1])
        if url.endswith("/fundslist"):
            payload = json.dumps([fund])
        else:
            assert kwargs["params"]["id"] == "SHK122"
            payload = history
        return httpx.Response(200, request=httpx.Request(method, url), text=payload)

    monkeypatch.setattr(httpx.Client, "request", fake_request)
    monkeypatch.setattr(
        manulife,
        "is_fund_exists",
        lambda _connection, record: f"MANULIFE:{record.fund_id}",
    )
    connection = FakeConnection([{"inserted": True}, {"inserted": True}])
    engine = FakeEngine(connection)

    result = jobs.run_job(
        provider="manulife",
        from_date=date(2026, 10, 7),
        to_date=date(2026, 10, 8),
        pg_engine=engine,
    )

    assert requests == ["fundslist", "fundhistory"]
    assert connection.price_writes == [
        {
            "fund_id": "MANULIFE:SHK122",
            "price_date": date(2026, 10, 7),
            "price": Decimal("17.251"),
        },
        {
            "fund_id": "MANULIFE:SHK122",
            "price_date": date(2026, 10, 8),
            "price": Decimal("17.195"),
        },
    ]
    assert result["inserted"] == 2
    assert result["updated"] == 0
    assert result["unchanged"] == 0
    assert result["min_changed_date"] == date(2026, 10, 7)
    assert result["max_changed_date"] == date(2026, 10, 8)
    assert result["funds_failed"] == []
    assert engine.transactions == 1


def test_crawl_fetches_fundslist_then_history_for_every_fund(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    fixture = (FIXTURE_DIR / "manulife_fundslist.json").read_text(encoding="utf-8")

    def fake_request(_client, method, url, **kwargs):
        if url.endswith("/fundslist"):
            calls.append("fundslist")
            payload = fixture
        else:
            fund_id = kwargs["params"]["id"]
            calls.append(fund_id)
            payload = json.dumps(
                {
                    "fundId": fund_id,
                    "priceHistory": [{"asOfDate": "2026-10-02", "price": 10.5}],
                }
            )
        return httpx.Response(200, request=httpx.Request(method, url), text=payload)

    monkeypatch.setattr(httpx.Client, "request", fake_request)

    result = manulife.crawl(
        from_date=date(2026, 10, 2), to_date=date(2026, 10, 2)
    )
    fund_ids = {fund.fund_id for fund in parse_manulife_fundslist(fixture)}

    assert calls[0] == "fundslist"
    assert set(calls[1:]) == fund_ids
    assert len(calls) == 1 + len(fund_ids)
    assert {record.fund_id for record in result["records"]} == fund_ids
    assert all(record.price == Decimal("10.5") for record in result["records"])
    assert result["funds_failed"] == []


def test_crawl_reports_failed_fund_history_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = '[{"fundId":"SHK122","fundName":"Stable Fund"}]'

    def fake_request(_client, method, url, **_kwargs):
        request = httpx.Request(method, url)
        if url.endswith("/fundslist"):
            return httpx.Response(200, request=request, text=fixture)
        raise httpx.ConnectError("history unavailable", request=request)

    monkeypatch.setattr(httpx.Client, "request", fake_request)
    monkeypatch.setattr(http_client.time, "sleep", lambda _seconds: None)

    result = manulife.crawl(
        from_date=date(2026, 10, 1), to_date=date(2026, 10, 7)
    )

    assert result["records"] == []
    assert len(result["funds_failed"]) == 1
    assert result["funds_failed"][0]["fund_id"] == "MANULIFE:SHK122"
    assert "history unavailable" in result["funds_failed"][0]["error"]
    assert result["funds_failed"][0]["note"] == "fundhistory_fetch_failed"


def test_crawl_returns_flat_records_and_reports_each_failed_fund(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        manulife,
        "fetch_manulife_fundslist",
        lambda **_kwargs: {
            "payload": '[{"fundId":"SHK122","fundName":"Stable Fund"},'
            '{"fundId":"SHK123","fundName":"Growth Fund"},'
            '{"fundId":"SHK124","fundName":"Other Fund"}]',
            "source": "manulife.fundslist",
            "status_code": 200,
            "fetched_at": "",
        },
    )

    def fake_fetch_history(*, fund_id, **_kwargs):
        if fund_id == "SHK124":
            raise ValueError("request failed")
        payload = (
            '{"fundId":"SHK122","priceHistory":['
            '{"asOfDate":"2026-10-07","price":17.251}]}'
            if fund_id == "SHK122"
            else "{}"
        )
        return {
            "payload": payload,
            "source": "manulife.fundhistory",
            "status_code": 200,
            "fetched_at": "",
        }

    monkeypatch.setattr(manulife, "fetch_manulife_fundhistory", fake_fetch_history)

    result = manulife.crawl(
        from_date=date(2026, 10, 7), to_date=date(2026, 10, 7)
    )

    assert result["records"] == [
        ManulifePriceRecord(
            fund_id="SHK122",
            fund_name="Stable Fund",
            currency="HKD",
            price_date=date(2026, 10, 7),
            price=Decimal("17.251"),
        )
    ]
    assert {
        (failure["fund_id"], failure["note"])
        for failure in result["funds_failed"]
    } == {
        ("MANULIFE:SHK123", "fundhistory_parse_failed"),
        ("MANULIFE:SHK124", "fundhistory_fetch_failed"),
    }


def test_run_job_runs_both_provider_pipelines(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(jobs, "crawl_hsbc", lambda **_kwargs: {"payload": "hsbc csv"})
    monkeypatch.setattr(
        jobs,
        "parse_all_hsbc_funds_csv",
        lambda payload: calls.append(f"parse {payload}") or ["hsbc record"],
    )
    monkeypatch.setattr(
        jobs,
        "save_hsbc_records",
        lambda _engine, records: calls.append(f"save {records[0]}") or {"inserted": 1},
    )
    monkeypatch.setattr(
        jobs,
        "crawl_manulife",
        lambda **_kwargs: {
            "records": ["manulife record"],
            "funds_failed": [],
        },
    )

    def fake_save(_engine, records):
        calls.append(f"save {records[0]}")
        return {"inserted": 1}

    monkeypatch.setattr(jobs, "save_manulife_records", fake_save)

    result = jobs.run_job(
        provider="all",
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        pg_engine=object(),
    )

    assert calls == [
        "parse hsbc csv",
        "save hsbc record",
        "save manulife record",
    ]
    assert result == {
        "hsbc": {"inserted": 1},
        "manulife": {"inserted": 1, "funds_failed": []},
    }


def test_backfill_uses_explicit_date_range(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    def fake_run_job(**kwargs):
        seen.update(kwargs)
        return {"funds_seen": 1}

    monkeypatch.setattr(jobs, "run_job", fake_run_job)
    engine = object()
    result = jobs.process_backfill_job(
        CONFIG,
        engine,
        {
            "provider": "manulife",
            "from_date": "2020-01-01",
            "to_date": "2026-10-07",
        },
    )

    assert result == {"funds_seen": 1}
    assert seen == {
        "provider": "manulife",
        "from_date": date(2020, 1, 1),
        "to_date": date(2026, 10, 7),
        "pg_engine": engine,
    }


@pytest.mark.parametrize(
    "payload, message",
    [
        ({"provider": "manulife"}, "from_date and to_date are required"),
        (
            {
                "provider": "manulife",
                "from_date": "invalid",
                "to_date": "2026-10-07",
            },
            "from_date and to_date are required",
        ),
        (
            {
                "provider": "manulife",
                "from_date": "2026-10-08",
                "to_date": "2026-10-07",
            },
            "from_date must be <= to_date",
        ),
    ],
)
def test_backfill_rejects_invalid_date_ranges(payload: dict, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        jobs.process_backfill_job(CONFIG, object(), payload)


def test_sync_defaults_to_seven_day_window(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    def fake_run_job(**kwargs):
        seen.update(kwargs)
        return {"funds_seen": 1}

    monkeypatch.setattr(jobs, "run_job", fake_run_job)

    jobs.process_sync_job(CONFIG, object(), {"provider": "manulife"})

    assert (seen["to_date"] - seen["from_date"]).days == 6


@pytest.mark.parametrize("rolling_days", [0, 29])
def test_sync_rejects_invalid_rolling_days(rolling_days: int) -> None:
    with pytest.raises(ValueError, match="rolling_days must be between 1 and 28"):
        jobs.process_sync_job(
            CONFIG,
            object(),
            {"provider": "manulife", "rolling_days": rolling_days},
        )


def test_run_job_rejects_invalid_provider() -> None:
    with pytest.raises(ValueError, match="provider must be one of"):
        jobs.run_job(
            provider="invalid",
            from_date=date(2026, 10, 1),
            to_date=date(2026, 10, 7),
            pg_engine=object(),
        )


def test_history_parse_failure_is_reported_per_fund(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        jobs,
        "crawl_manulife",
        lambda **_kwargs: {
            "records": [],
            "funds_failed": [
                {
                    "fund_id": "MANULIFE:SHK122",
                    "error": "Manulife fundhistory priceHistory must be an array",
                    "note": "fundhistory_parse_failed",
                }
            ],
        },
    )

    def fake_save(_engine, records):
        assert records == []
        return {"inserted": 0}

    monkeypatch.setattr(jobs, "save_manulife_records", fake_save)

    result = jobs.run_job(
        provider="manulife",
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        pg_engine=object(),
    )

    assert result["funds_failed"][0]["fund_id"] == "MANULIFE:SHK122"
    assert result["funds_failed"][0]["note"] == "fundhistory_parse_failed"


def test_save_records_reports_the_same_write_stats_as_hsbc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    records = [
        ManulifePriceRecord(
            fund_id="SHK122",
            fund_name="Stable Fund",
            currency="HKD",
            price_date=price_date,
            price=price,
        )
        for price_date, price in [
            (date(2026, 10, 1), Decimal("10.1")),
            (date(2026, 10, 7), Decimal("10.7")),
            (date(2026, 10, 8), Decimal("10.8")),
        ]
    ]
    fund_lookups: list[str] = []

    def fake_is_fund_exists(_connection, record):
        fund_lookups.append(record.fund_id)
        return f"MANULIFE:{record.fund_id}"

    monkeypatch.setattr(
        manulife,
        "is_fund_exists",
        fake_is_fund_exists,
    )
    connection = FakeConnection([{"inserted": True}, {"inserted": False}, None])
    engine = FakeEngine(connection)

    stats = manulife.save_records(engine, records)

    assert connection.price_writes == [
        {
            "fund_id": "MANULIFE:SHK122",
            "price_date": date(2026, 10, 1),
            "price": Decimal("10.1"),
        },
        {
            "fund_id": "MANULIFE:SHK122",
            "price_date": date(2026, 10, 7),
            "price": Decimal("10.7"),
        },
        {
            "fund_id": "MANULIFE:SHK122",
            "price_date": date(2026, 10, 8),
            "price": Decimal("10.8"),
        },
    ]
    assert fund_lookups == ["SHK122", "SHK122", "SHK122"]
    assert stats == {
        "inserted": 1,
        "updated": 1,
        "unchanged": 1,
        "min_changed_date": date(2026, 10, 1),
        "max_changed_date": date(2026, 10, 7),
    }
    assert engine.transactions == 1


def test_no_history_records_produce_no_price_writes() -> None:
    stats = manulife.save_records(FakeEngine(), [])

    assert stats == {
        "inserted": 0,
        "updated": 0,
        "unchanged": 0,
        "min_changed_date": None,
        "max_changed_date": None,
    }


def test_interest_fund_zero_history_price_is_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        manulife,
        "fetch_manulife_fundslist",
        lambda **_kwargs: {
            "payload": '[{"fundId":"DHK121","fundName":"Interest Fund"}]',
            "source": "manulife.fundslist",
            "status_code": 200,
            "fetched_at": "",
        },
    )
    monkeypatch.setattr(
        manulife,
        "fetch_manulife_fundhistory",
        lambda **_kwargs: {
            "payload": '{"fundId":"DHK121","priceHistory":['
            '{"asOfDate":"2026-10-07","price":0}]}',
            "source": "manulife.fundhistory",
            "status_code": 200,
            "fetched_at": "",
        },
    )

    result = manulife.crawl(
        from_date=date(2026, 10, 7),
        to_date=date(2026, 10, 7),
    )

    assert result["records"] == []
    assert result["funds_failed"] == []
