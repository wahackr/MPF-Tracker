from __future__ import annotations

import csv
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from io import StringIO
from pathlib import Path
import sys

import pytest

WORKER_SRC_DIR = Path(__file__).resolve().parents[2]
if str(WORKER_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC_DIR))

from libs.crawlers import hsbc


def test_parse_transposes_date_rows_and_groups_bid_offer_by_fund() -> None:
    payload = (
        '"","10/9/2026","10/9/2026"\n'
        '"Constituent Fund","BID","OFFER"\n'
        '"Age 65 Plus Fund","14.1907","14.2907"\n'
        '"Asia Pacific Equity Fund","43.3973","43.4973"\n'
    )

    records = hsbc.parse_all_funds_csv(payload)

    assert records == [
        hsbc.HsbcPriceRecord(
            fund_name="Age 65 Plus Fund",
            price_date=date(2026, 9, 10),
            bid=Decimal("14.1907"),
            offer=Decimal("14.2907"),
        ),
        hsbc.HsbcPriceRecord(
            fund_name="Asia Pacific Equity Fund",
            price_date=date(2026, 9, 10),
            bid=Decimal("43.3973"),
            offer=Decimal("43.4973"),
        ),
    ]


def test_crawl_merges_chunk_columns_by_fund_name(monkeypatch: pytest.MonkeyPatch) -> None:
    first = (
        '\ufeff"","2026-10-01","2026-10-01"\n'
        '"Constituent Fund","BID","OFFER"\n'
        '"Fund A","1.1","1.2"\n'
        '"Fund B","2.1","2.2"\n'
    )
    second = (
        '"","2026-10-29","2026-10-29"\n'
        '"Constituent Fund","BID","OFFER"\n'
        '"Fund B","2.3","2.4"\n'
        '"Fund A","1.3","1.4"\n'
    )
    responses = iter((first, second))
    calls: list[tuple[date, date]] = []

    def fake_fetch(**kwargs):
        calls.append((kwargs["from_date"], kwargs["to_date"]))
        return {
            "source": "hsbc.download-funds",
            "payload": next(responses),
            "status_code": 200,
            "fetched_at": kwargs["to_date"].isoformat(),
        }

    monkeypatch.setattr(hsbc, "fetch_all_funds_csv", fake_fetch)

    result = hsbc.crawl(
        from_date=date(2026, 10, 1), to_date=date(2026, 10, 29)
    )
    records = hsbc.parse_all_funds_csv(result["payload"])

    assert calls == [
        (date(2026, 10, 1), date(2026, 10, 28)),
        (date(2026, 10, 29), date(2026, 10, 29)),
    ]
    assert result["chunks"] == [
        {
            "from_date": "2026-10-01",
            "to_date": "2026-10-28",
            "source": "hsbc.download-funds",
            "status_code": 200,
            "fetched_at": "2026-10-28",
        },
        {
            "from_date": "2026-10-29",
            "to_date": "2026-10-29",
            "source": "hsbc.download-funds",
            "status_code": 200,
            "fetched_at": "2026-10-29",
        },
    ]
    assert len(records) == 4
    assert {(row.fund_name, row.price_date, row.bid) for row in records} == {
        ("Fund A", date(2026, 10, 1), Decimal("1.1")),
        ("Fund A", date(2026, 10, 29), Decimal("1.3")),
        ("Fund B", date(2026, 10, 1), Decimal("2.1")),
        ("Fund B", date(2026, 10, 29), Decimal("2.3")),
    }


def test_crawl_returns_single_payload_and_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    fetched = {
        "source": "hsbc.download-funds",
        "payload": "raw csv",
        "status_code": 200,
        "fetched_at": "test",
    }
    monkeypatch.setattr(hsbc, "fetch_all_funds_csv", lambda **_kwargs: fetched)

    assert hsbc.crawl(
        from_date=date(2026, 10, 1), to_date=date(2026, 10, 1)
    ) == {
        "payload": "raw csv",
        "chunks": [
            {
                "from_date": "2026-10-01",
                "to_date": "2026-10-01",
                "source": "hsbc.download-funds",
                "status_code": 200,
                "fetched_at": "test",
            }
        ],
    }


def test_crawl_output_parses_real_fixture_across_chunks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = (
        Path(__file__).resolve().parents[5]
        / "mpf-codex-handoff/fixtures/hsbc_all_supertrust_20260901_20261007.csv"
    ).read_text(encoding="utf-8-sig")
    rows = list(csv.reader(StringIO(fixture)))

    def fake_fetch(**kwargs):
        start, end = kwargs["from_date"], kwargs["to_date"]
        columns = [0] + [
            index
            for index in range(1, len(rows[0]))
            if start <= date.fromisoformat(rows[0][index]) <= end
        ]
        output = StringIO()
        csv.writer(output).writerows(
            [[row[index] for index in columns] for row in rows]
        )
        return {
            "source": "hsbc.download-funds",
            "payload": output.getvalue(),
            "status_code": 200,
            "fetched_at": "test",
        }

    monkeypatch.setattr(hsbc, "fetch_all_funds_csv", fake_fetch)

    result = hsbc.crawl(
        from_date=date(2026, 9, 1), to_date=date(2026, 10, 7)
    )

    assert hsbc.parse_all_funds_csv(result["payload"]) == hsbc.parse_all_funds_csv(
        fixture
    )


def test_save_records_accepts_parsed_hsbc_fixture() -> None:
    fixture = (
        Path(__file__).resolve().parents[5]
        / "mpf-codex-handoff/fixtures/hsbc_all_supertrust_20260901_20261007.csv"
    ).read_text(encoding="utf-8-sig")
    records = hsbc.parse_all_funds_csv(fixture)
    price_writes: list[dict] = []

    class FakeResult:
        def scalar_one_or_none(self):
            return None

        def mappings(self):
            return self

        def first(self):
            return {"inserted": True}

    class FakeConnection:
        def execute(self, statement, params):
            if "INSERT INTO mpf.fund_prices" in str(statement):
                price_writes.append(params)
            return FakeResult()

    class FakeEngine:
        @contextmanager
        def begin(self):
            yield FakeConnection()

    stats = hsbc.save_records(FakeEngine(), records)

    assert stats == {
        "inserted": 520,
        "updated": 0,
        "unchanged": 0,
        "min_changed_date": date(2026, 9, 1),
        "max_changed_date": date(2026, 10, 7),
    }
    assert len(price_writes) == 520
    assert all(isinstance(item["price_date"], date) for item in price_writes)
    assert all(isinstance(item["bid"], Decimal) for item in price_writes)
    assert all(isinstance(item["offer"], Decimal) for item in price_writes)
