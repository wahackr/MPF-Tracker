from __future__ import annotations

import csv
import sys
from datetime import date
from decimal import Decimal
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs.crawlers import hsbc  # type: ignore[import-not-found]

TEST_FUND_PREFIX = "HSBC:PYTEST_"
FIXTURES_DIR = Path(__file__).resolve().parents[5] / "mpf-codex-handoff" / "fixtures"


@pytest.fixture
def hsbc_pg_engine(crawler_pg_engine: Engine):
    _delete_test_records(crawler_pg_engine)
    yield crawler_pg_engine
    _delete_test_records(crawler_pg_engine)


def _delete_test_records(pg_engine: Engine) -> None:
    with pg_engine.begin() as connection:
        connection.execute(
            text("DELETE FROM mpf.fund_prices WHERE fund_id LIKE :prefix"),
            {"prefix": f"{TEST_FUND_PREFIX}%"},
        )
        connection.execute(
            text("DELETE FROM mpf.fund_aliases WHERE fund_id LIKE :prefix"),
            {"prefix": f"{TEST_FUND_PREFIX}%"},
        )
        connection.execute(
            text(
                "DELETE FROM mpf.fund_scheme_memberships "
                "WHERE fund_id LIKE :prefix"
            ),
            {"prefix": f"{TEST_FUND_PREFIX}%"},
        )
        connection.execute(
            text("DELETE FROM mpf.funds WHERE fund_id LIKE :prefix"),
            {"prefix": f"{TEST_FUND_PREFIX}%"},
        )


def _insert_fund(
    pg_engine: Engine,
    *,
    fund_id: str,
    provider_code: str,
    name: str,
    alias: str | None = None,
) -> None:
    with pg_engine.begin() as connection:
        connection.execute(
            text("""
                INSERT INTO mpf.funds (
                    fund_id, provider, provider_fund_code, name, currency,
                    last_seen_at, updated_at
                )
                VALUES (
                    :fund_id, 'hsbc', :provider_code, :name, 'HKD',
                    '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z'
                )
                """),
            {
                "fund_id": fund_id,
                "provider_code": provider_code,
                "name": name,
            },
        )
        if alias is not None:
            connection.execute(
                text("""
                    INSERT INTO mpf.fund_aliases (fund_id, alias, source)
                    VALUES (:fund_id, :alias, 'pytest')
                    """),
                {"fund_id": fund_id, "alias": alias},
            )


def test_fetch_all_funds_csv(monkeypatch: pytest.MonkeyPatch) -> None:
    response = SimpleNamespace(
        text="fixture csv",
        status_code=200,
        headers={"date": "Tue, 13 Oct 2026 03:00:00 GMT"},
    )
    request_arguments: dict[str, object] = {}

    def fake_request_with_retry(**kwargs):
        request_arguments.update(kwargs)
        return response

    monkeypatch.setattr(hsbc, "request_with_retry", fake_request_with_retry)

    result = hsbc.fetch_all_funds_csv(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
    )

    assert result == {
        "source": "hsbc.download-funds",
        "payload": "fixture csv",
        "status_code": 200,
        "fetched_at": "Tue, 13 Oct 2026 03:00:00 GMT",
    }
    assert request_arguments == {
        "timeout_seconds": 30.0,
        "retries": 3,
        "backoff_seconds": 1.5,
        "method": "GET",
        "url": (
            "https://rbwm-api.hsbc.com.hk/"
            "wpb-gpbw-mmw-hk-hbap-pa-p-wpp-mpf-market-data-prod-proxy/"
            "v1/download-funds"
        ),
        "params": {
            "schemeCodes": "HB",
            "fundPricePeriodFrom": "2026-10-01",
            "fundPricePeriodTo": "2026-10-07",
            "language": "en_US",
        },
        "headers": {"Accept": "*/*"},
    }


def test_merge_csv_payloads() -> None:
    first_payload = (
        '\ufeff"","2026-10-01","2026-10-01"\n'
        '"Constituent Fund","BID","OFFER"\n'
        '"Fund A","1.1","1.2"\n'
        '"Fund B","2.1","2.2"\n'
    )
    second_payload = (
        '"","2026-10-02","2026-10-02"\n'
        '"Constituent Fund","BID","OFFER"\n'
        '"Fund B","2.3","2.4"\n'
        '"Fund A","1.3","1.4"\n'
    )

    merged = hsbc.merge_csv_payloads([first_payload, second_payload])

    assert list(csv.reader(StringIO(merged))) == [
        ["", "2026-10-01", "2026-10-01", "2026-10-02", "2026-10-02"],
        ["Constituent Fund", "BID", "OFFER", "BID", "OFFER"],
        ["Fund A", "1.1", "1.2", "1.3", "1.4"],
        ["Fund B", "2.1", "2.2", "2.3", "2.4"],
    ]


def test_crawl_merges_date_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    first_payload = (
        '"","2026-10-01","2026-10-01"\n'
        '"Constituent Fund","BID","OFFER"\n'
        '"Fund A","1.1","1.2"\n'
    )
    second_payload = (
        '"","2026-10-29","2026-10-29"\n'
        '"Constituent Fund","BID","OFFER"\n'
        '"Fund A","1.3","1.4"\n'
    )
    payloads = iter([first_payload, second_payload])
    requested_ranges: list[tuple[date, date]] = []

    def fake_fetch(**kwargs):
        requested_ranges.append((kwargs["from_date"], kwargs["to_date"]))
        return {
            "source": "hsbc.download-funds",
            "payload": next(payloads),
            "status_code": 200,
            "fetched_at": kwargs["to_date"].isoformat(),
        }

    monkeypatch.setattr(hsbc, "fetch_all_funds_csv", fake_fetch)

    result = hsbc.crawl(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 29),
    )

    assert requested_ranges == [
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
    assert hsbc.parse_all_funds_csv(result["payload"]) == [
        hsbc.HsbcPriceRecord(
            "Fund A", date(2026, 10, 1), Decimal("1.1"), Decimal("1.2")
        ),
        hsbc.HsbcPriceRecord(
            "Fund A", date(2026, 10, 29), Decimal("1.3"), Decimal("1.4")
        ),
    ]


def test_crawl_returns_single_chunk_without_merging(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fetched = {
        "source": "hsbc.download-funds",
        "payload": "raw csv",
        "status_code": 200,
        "fetched_at": "2026-10-01",
    }
    monkeypatch.setattr(hsbc, "fetch_all_funds_csv", lambda **_kwargs: fetched)

    result = hsbc.crawl(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 1),
    )

    assert result == {
        "payload": "raw csv",
        "chunks": [
            {
                "from_date": "2026-10-01",
                "to_date": "2026-10-01",
                "source": "hsbc.download-funds",
                "status_code": 200,
                "fetched_at": "2026-10-01",
            }
        ],
    }


def test_parse_all_funds_csv() -> None:
    payload = (
        '"","2026-10-01","2026-10-01","2026-10-02","2026-10-02"\n'
        '"Constituent Fund","BID","OFFER","BID","OFFER"\n'
        '"Fund A","1.1","1.2","1.3","1.4"\n'
        '"Fund B","2.1","2.2","2.3","2.4"\n'
    )

    records = hsbc.parse_all_funds_csv(payload)

    assert records == [
        hsbc.HsbcPriceRecord("Fund A", date(2026, 10, 1), Decimal("1.1"), Decimal("1.2")),
        hsbc.HsbcPriceRecord("Fund A", date(2026, 10, 2), Decimal("1.3"), Decimal("1.4")),
        hsbc.HsbcPriceRecord("Fund B", date(2026, 10, 1), Decimal("2.1"), Decimal("2.2")),
        hsbc.HsbcPriceRecord("Fund B", date(2026, 10, 2), Decimal("2.3"), Decimal("2.4")),
    ]


def test_parse_all_funds_csv_fixture_count() -> None:
    payload = (FIXTURES_DIR / "hsbc_all_supertrust_20260901_20261007.csv").read_text(
        encoding="utf-8"
    )

    records = hsbc.parse_all_funds_csv(payload)

    assert len(records) == 520
    assert len({record.fund_name for record in records}) == 20
    assert len({record.price_date for record in records}) == 26


@pytest.mark.parametrize(
    ("payload", "expected_message"),
    [
        (
            '"","2026-09-01","2026-09-01"\n'
            '"Constituent Fund","BID","OFFER"\n'
            '"Age 65 Plus Fund","1.0"\n',
            "row 3 width mismatch",
        ),
        (
            '"","2026-09-01","2026-09-01","2026-09-01","2026-09-01"\n'
            '"Constituent Fund","BID","OFFER","BID","OFFER"\n'
            '"Age 65 Plus Fund","1.0","1.0","1.1","1.1"\n',
            "duplicate header pair",
        ),
        (
            '"","2026-13-01","2026-13-01"\n'
            '"Constituent Fund","BID","OFFER"\n'
            '"Age 65 Plus Fund","1.0","1.0"\n',
            "Invalid date value",
        ),
        (
            '"","2026-09-01","2026-09-01"\n'
            '"Constituent Fund","BID","OFFER"\n'
            '"Age 65 Plus Fund","abc","1.0"\n',
            "Invalid decimal value",
        ),
        (
            '"","2026-09-01","2026-09-01"\n'
            '"Constituent Fund","BID","BID"\n'
            '"Age 65 Plus Fund","1.0","1.0"\n',
            "must be BID/OFFER",
        ),
    ],
)
def test_parse_all_funds_csv_rejects_invalid_payloads(
    payload: str,
    expected_message: str,
) -> None:
    with pytest.raises(hsbc.ParseError, match=expected_message):
        hsbc.parse_all_funds_csv(payload)


@pytest.mark.integration
def test_update_fund(hsbc_pg_engine: Engine) -> None:
    fund_id = "HSBC:PYTEST_UPDATE"
    _insert_fund(
        hsbc_pg_engine,
        fund_id=fund_id,
        provider_code="PYTEST_UPDATE",
        name="Pytest Update Fund",
    )

    with hsbc_pg_engine.begin() as connection:
        hsbc.update_fund(connection, fund_id)

    with hsbc_pg_engine.connect() as connection:
        row = connection.execute(
            text("""
                SELECT last_seen_at, updated_at
                FROM mpf.funds
                WHERE fund_id = :fund_id
                """),
            {"fund_id": fund_id},
        ).one()

    assert row.last_seen_at.year > 2000
    assert row.updated_at.year > 2000


@pytest.mark.integration
def test_is_fund_exists_yes(hsbc_pg_engine: Engine) -> None:
    fund_id = "HSBC:PYTEST_EXISTING"
    fund_name = "Pytest Existing Fund"
    _insert_fund(
        hsbc_pg_engine,
        fund_id=fund_id,
        provider_code="PYTEST_EXISTING",
        name=fund_name,
        alias=fund_name,
    )

    with hsbc_pg_engine.begin() as connection:
        returned_fund_id = hsbc.is_fund_exists(connection, fund_name)

    with hsbc_pg_engine.connect() as connection:
        row = connection.execute(
            text("""
                SELECT name, last_seen_at,
                       (SELECT count(*) FROM mpf.fund_aliases WHERE fund_id = :fund_id) AS aliases
                FROM mpf.funds
                WHERE fund_id = :fund_id
                """),
            {"fund_id": fund_id},
        ).one()

    assert returned_fund_id == fund_id
    assert row.name == fund_name
    assert row.last_seen_at.year > 2000
    assert row.aliases == 1


@pytest.mark.integration
def test_is_fund_exists_no(hsbc_pg_engine: Engine) -> None:
    fund_name = "Pytest New Fund"

    with hsbc_pg_engine.begin() as connection:
        fund_id = hsbc.is_fund_exists(connection, fund_name)

    with hsbc_pg_engine.connect() as connection:
        fund = connection.execute(
            text("""
                SELECT provider, provider_fund_code, name, currency
                FROM mpf.funds
                WHERE fund_id = :fund_id
                """),
            {"fund_id": fund_id},
        ).mappings().one()
        aliases = connection.execute(
            text("SELECT alias FROM mpf.fund_aliases WHERE fund_id = :fund_id"),
            {"fund_id": fund_id},
        ).scalars().all()
        memberships = connection.execute(
            text(
                "SELECT provider_scheme_code FROM mpf.fund_scheme_memberships "
                "WHERE fund_id = :fund_id"
            ),
            {"fund_id": fund_id},
        ).scalars().all()

    assert fund_id == "HSBC:PYTEST_NEW_FUND"
    assert dict(fund) == {
        "provider": "hsbc",
        "provider_fund_code": "PYTEST_NEW_FUND",
        "name": fund_name,
        "currency": "HKD",
    }
    assert aliases == [fund_name]
    assert memberships == ["HB"]


@pytest.mark.integration
def test_is_fund_exists_no_conflict(hsbc_pg_engine: Engine) -> None:
    fund_id = "HSBC:PYTEST_CONFLICT_FUND"
    fund_name = "Pytest Conflict Fund"
    _insert_fund(
        hsbc_pg_engine,
        fund_id=fund_id,
        provider_code="PYTEST_CONFLICT_FUND",
        name="Old Fund Name",
    )

    with hsbc_pg_engine.begin() as connection:
        returned_fund_id = hsbc.is_fund_exists(connection, fund_name)

    with hsbc_pg_engine.connect() as connection:
        fund_count = connection.execute(
            text("SELECT count(*) FROM mpf.funds WHERE fund_id = :fund_id"),
            {"fund_id": fund_id},
        ).scalar_one()
        stored_name = connection.execute(
            text("SELECT name FROM mpf.funds WHERE fund_id = :fund_id"),
            {"fund_id": fund_id},
        ).scalar_one()
        alias = connection.execute(
            text("SELECT alias FROM mpf.fund_aliases WHERE fund_id = :fund_id"),
            {"fund_id": fund_id},
        ).scalar_one()

    assert returned_fund_id == fund_id
    assert fund_count == 1
    assert stored_name == fund_name
    assert alias == fund_name


@pytest.mark.integration
def test_save_records(hsbc_pg_engine: Engine) -> None:
    records = [
        hsbc.HsbcPriceRecord(
            "Pytest Save Fund",
            date(2026, 10, 1),
            Decimal("10.1"),
            Decimal("10.2"),
        ),
        hsbc.HsbcPriceRecord(
            "Pytest Save Fund",
            date(2026, 10, 2),
            Decimal("10.3"),
            Decimal("10.4"),
        ),
    ]

    result = hsbc.save_records(hsbc_pg_engine, records)

    with hsbc_pg_engine.connect() as connection:
        stored_prices = connection.execute(
            text("""
                SELECT price_date, bid, offer, source
                FROM mpf.fund_prices
                WHERE fund_id = 'HSBC:PYTEST_SAVE_FUND'
                ORDER BY price_date
                """)
        ).all()

    assert result == {
        "inserted": 2,
        "updated": 0,
        "unchanged": 0,
        "min_changed_date": date(2026, 10, 1),
        "max_changed_date": date(2026, 10, 2),
    }
    assert stored_prices == [
        (date(2026, 10, 1), Decimal("10.1000000000"), Decimal("10.2000000000"), "hsbc_csv"),
        (date(2026, 10, 2), Decimal("10.3000000000"), Decimal("10.4000000000"), "hsbc_csv"),
    ]


@pytest.mark.integration
def test_save_records_conflict(hsbc_pg_engine: Engine) -> None:
    original = hsbc.HsbcPriceRecord(
        "Pytest Save Conflict Fund",
        date(2026, 10, 3),
        Decimal("20.1"),
        Decimal("20.2"),
    )
    changed = hsbc.HsbcPriceRecord(
        "Pytest Save Conflict Fund",
        date(2026, 10, 3),
        Decimal("21.1"),
        Decimal("21.2"),
    )

    inserted = hsbc.save_records(hsbc_pg_engine, [original])
    unchanged = hsbc.save_records(hsbc_pg_engine, [original])
    updated = hsbc.save_records(hsbc_pg_engine, [changed])

    with hsbc_pg_engine.connect() as connection:
        stored = connection.execute(
            text("""
                SELECT bid, offer
                FROM mpf.fund_prices
                WHERE fund_id = 'HSBC:PYTEST_SAVE_CONFLICT_FUND'
                  AND price_date = '2026-10-03'
                """)
        ).one()

    assert inserted["inserted"] == 1
    assert unchanged == {
        "inserted": 0,
        "updated": 0,
        "unchanged": 1,
        "min_changed_date": None,
        "max_changed_date": None,
    }
    assert updated == {
        "inserted": 0,
        "updated": 1,
        "unchanged": 0,
        "min_changed_date": date(2026, 10, 3),
        "max_changed_date": date(2026, 10, 3),
    }
    assert stored == (Decimal("21.1000000000"), Decimal("21.2000000000"))


def test_crawl_has_fetch_results(monkeypatch: pytest.MonkeyPatch) -> None:
    fetch_results = [
        {
            "source": "hsbc.download-funds",
            "payload": "first CSV",
            "status_code": 200,
            "fetched_at": "2026-10-28T12:00:00Z",
        },
        {
            "source": "hsbc.download-funds",
            "payload": "second CSV",
            "status_code": 200,
            "fetched_at": "2026-10-29T12:00:00Z",
        },
    ]
    fetch_all_funds_csv = Mock(side_effect=fetch_results)
    merged_payloads: list[str] = []

    def fake_merge_csv_payloads(payloads) -> str:
        merged_payloads.extend(payloads)
        return "merged CSV"

    merge_csv_payloads = Mock(side_effect=fake_merge_csv_payloads)
    monkeypatch.setattr(hsbc, "fetch_all_funds_csv", fetch_all_funds_csv)
    monkeypatch.setattr(hsbc, "merge_csv_payloads", merge_csv_payloads)

    result = hsbc.crawl(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 29),
    )

    assert result == {
        "payload": "merged CSV",
        "chunks": [
            {
                "from_date": "2026-10-01",
                "to_date": "2026-10-28",
                "source": "hsbc.download-funds",
                "status_code": 200,
                "fetched_at": "2026-10-28T12:00:00Z",
            },
            {
                "from_date": "2026-10-29",
                "to_date": "2026-10-29",
                "source": "hsbc.download-funds",
                "status_code": 200,
                "fetched_at": "2026-10-29T12:00:00Z",
            },
        ],
    }
    fetch_all_funds_csv.assert_has_calls(
        [
            call(
                from_date=date(2026, 10, 1),
                to_date=date(2026, 10, 28),
                timeout_seconds=30.0,
                retries=3,
                backoff_seconds=1.5,
            ),
            call(
                from_date=date(2026, 10, 29),
                to_date=date(2026, 10, 29),
                timeout_seconds=30.0,
                retries=3,
                backoff_seconds=1.5,
            ),
        ]
    )
    assert fetch_all_funds_csv.call_count == 2
    merge_csv_payloads.assert_called_once()
    assert merged_payloads == ["first CSV", "second CSV"]


def test_crawl_no_results(monkeypatch: pytest.MonkeyPatch) -> None:
    fetch_all_funds_csv = Mock(
        return_value={
            "source": "hsbc.download-funds",
            "payload": "",
            "status_code": 200,
            "fetched_at": "2026-10-01T12:00:00Z",
        }
    )
    merge_csv_payloads = Mock(side_effect=AssertionError("one chunk must not merge"))
    monkeypatch.setattr(hsbc, "fetch_all_funds_csv", fetch_all_funds_csv)
    monkeypatch.setattr(hsbc, "merge_csv_payloads", merge_csv_payloads)

    result = hsbc.crawl(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 1),
    )

    assert result == {
        "payload": "",
        "chunks": [
            {
                "from_date": "2026-10-01",
                "to_date": "2026-10-01",
                "source": "hsbc.download-funds",
                "status_code": 200,
                "fetched_at": "2026-10-01T12:00:00Z",
            }
        ],
    }
    fetch_all_funds_csv.assert_called_once_with(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 1),
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
    )
    merge_csv_payloads.assert_not_called()
