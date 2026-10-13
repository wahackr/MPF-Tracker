from __future__ import annotations

import json
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs.crawlers import manulife  # type: ignore[import-not-found]

TEST_FUND_PREFIX = "MANULIFE:PYTEST_"
FIXTURES_DIR = Path(__file__).resolve().parents[5] / "mpf-codex-handoff" / "fixtures"


@pytest.fixture
def manulife_pg_engine(crawler_pg_engine: Engine):
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
    currency: str = "HKD",
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
                    :fund_id, 'manulife', :provider_code, :name, :currency,
                    '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z'
                )
                """),
            {
                "fund_id": fund_id,
                "provider_code": provider_code,
                "name": name,
                "currency": currency,
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


def _price_record(
    *,
    fund_id: str,
    fund_name: str,
    price_date: date,
    price: str,
    currency: str = "HKD",
) -> manulife.ManulifePriceRecord:
    return manulife.ManulifePriceRecord(
        fund_id=fund_id,
        fund_name=fund_name,
        currency=currency,
        price_date=price_date,
        bid=Decimal(price),
        offer=Decimal(price),
    )


def test_fetch_manulife_fundslist(monkeypatch: pytest.MonkeyPatch) -> None:
    response = SimpleNamespace(
        text='[{"fundId":"SHK122","fundName":"Stable Fund"}]',
        status_code=200,
        headers={"date": "Tue, 13 Oct 2026 03:00:00 GMT"},
    )
    request_arguments: dict[str, object] = {}

    def fake_request_with_retry(**kwargs):
        request_arguments.update(kwargs)
        return response

    monkeypatch.setattr(manulife, "request_with_retry", fake_request_with_retry)

    result = manulife.fetch_manulife_fundslist(
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
    )

    assert result == {
        "source": "manulife.fundslist",
        "payload": response.text,
        "status_code": 200,
        "fetched_at": "Tue, 13 Oct 2026 03:00:00 GMT",
    }
    assert request_arguments == {
        "timeout_seconds": 30.0,
        "retries": 3,
        "backoff_seconds": 1.5,
        "method": "GET",
        "url": "https://scmpf.manulife.com.hk/bin/funds/fundslist",
        "params": {"productLine": "mpf", "overrideLocale": "en_HK"},
        "headers": manulife._manulife_request_headers(),
    }


def test_fetch_manulife_fundhistory(monkeypatch: pytest.MonkeyPatch) -> None:
    response = SimpleNamespace(
        text='{"fundId":"SHK122","priceHistory":[]}',
        status_code=200,
        headers={"date": "Tue, 13 Oct 2026 03:00:00 GMT"},
    )
    request_arguments: dict[str, object] = {}

    def fake_request_with_retry(**kwargs):
        request_arguments.update(kwargs)
        return response

    monkeypatch.setattr(manulife, "request_with_retry", fake_request_with_retry)

    result = manulife.fetch_manulife_fundhistory(
        fund_id="SHK122",
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
    )

    assert result == {
        "source": "manulife.fundhistory",
        "payload": response.text,
        "status_code": 200,
        "fetched_at": "Tue, 13 Oct 2026 03:00:00 GMT",
    }
    assert request_arguments == {
        "timeout_seconds": 30.0,
        "retries": 3,
        "backoff_seconds": 1.5,
        "method": "GET",
        "url": "https://scmpf.manulife.com.hk/bin/funds/fundhistory",
        "params": {
            "id": "SHK122",
            "productLine": "mpf",
            "overrideLocale": "en_HK",
        },
        "headers": manulife._manulife_request_headers(),
    }


def test_parse_manulife_fundslist() -> None:
    payload = (FIXTURES_DIR / "manulife_fundslist.json").read_text(encoding="utf-8")

    records = manulife.parse_manulife_fundslist(payload)
    fund = next(record for record in records if record.fund_id == "DIS148")

    assert len(records) == 76
    assert fund == manulife.ManulifeFundRecord(
        fund_id="DIS148",
        fund_name="Manulife MPF Core Accumulation Fund ##",
        currency="HKD",
    )


def test_parse_manulife_fundslist_defaults_currency() -> None:
    records = manulife.parse_manulife_fundslist(
        '[{"fundId":"SHK122","fundName":"Stable Fund"}]'
    )

    assert records == [
        manulife.ManulifeFundRecord(
            fund_id="SHK122",
            fund_name="Stable Fund",
            currency="HKD",
        )
    ]


@pytest.mark.parametrize(
    ("payload", "expected_message"),
    [
        ("not json", "Invalid Manulife fundslist JSON payload"),
        ('{"fundId":"SHK122"}', "must be a top-level array"),
        ('["SHK122"]', "record at index 0 is not an object"),
        ('[{"fundId":"SHK122"}]', "missing fundId/fundName"),
    ],
)
def test_parse_manulife_fundslist_rejects_invalid_payloads(
    payload: str,
    expected_message: str,
) -> None:
    with pytest.raises(manulife.ParseError, match=expected_message):
        manulife.parse_manulife_fundslist(payload)


def test_parse_manulife_fundhistory() -> None:
    payload = (FIXTURES_DIR / "manulife_fundhistory_SHK122.json").read_text(
        encoding="utf-8"
    )

    records = manulife.parse_manulife_fundhistory(
        payload,
        expected_fund_id="SHK122",
    )

    assert records == [
        manulife.FundHistoryPoint(date(2000, 12, 1), Decimal("10.0")),
        manulife.FundHistoryPoint(date(2026, 10, 7), Decimal("17.251")),
        manulife.FundHistoryPoint(date(2026, 10, 8), Decimal("17.195")),
    ]


@pytest.mark.parametrize(
    ("payload", "expected_message"),
    [
        ("not json", "Invalid Manulife fundhistory JSON payload"),
        ("[]", "payload must be an object"),
        ('{"fundId":"OTHER","priceHistory":[]}', "fundId mismatch"),
        ('{"fundId":"SHK122"}', "priceHistory must be an array"),
        (
            '{"fundId":"SHK122","priceHistory":[{"asOfDate":"bad","price":10}]}',
            "invalid asOfDate/price",
        ),
        ('{"fundId":"SHK122","priceHistory":[]}', "contains no priceHistory records"),
    ],
)
def test_parse_manulife_fundhistory_rejects_invalid_payloads(
    payload: str,
    expected_message: str,
) -> None:
    with pytest.raises(manulife.ParseError, match=expected_message):
        manulife.parse_manulife_fundhistory(
            payload,
            expected_fund_id="SHK122",
        )


def test_crawl_fetches_history_for_every_fund_and_filters_prices(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        manulife,
        "fetch_manulife_fundslist",
        lambda **_kwargs: {
            "payload": (
                '[{"fundId":"PYTEST_A","fundName":"Fund A"},'
                '{"fundId":"PYTEST_B","fundName":"Fund B","currency":"USD"}]'
            ),
            "source": "manulife.fundslist",
            "status_code": 200,
            "fetched_at": "",
        },
    )
    history_calls: list[str] = []

    def fake_fetch_history(*, fund_id: str, **_kwargs):
        history_calls.append(fund_id)
        return {
            "payload": json.dumps(
                {
                    "fundId": fund_id,
                    "priceHistory": [
                        {"asOfDate": "2026-09-30", "price": 9.9},
                        {"asOfDate": "2026-10-01", "price": 10.1},
                        {"asOfDate": "2026-10-02", "price": 0},
                        {"asOfDate": "2026-10-08", "price": 10.8},
                    ],
                }
            ),
            "source": "manulife.fundhistory",
            "status_code": 200,
            "fetched_at": "",
        }

    monkeypatch.setattr(manulife, "fetch_manulife_fundhistory", fake_fetch_history)

    result = manulife.crawl(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
    )

    assert set(history_calls) == {"PYTEST_A", "PYTEST_B"}
    assert {
        (
            record.fund_id,
            record.currency,
            record.price_date,
            record.bid,
            record.offer,
        )
        for record in result["records"]
    } == {
        (
            "PYTEST_A",
            "HKD",
            date(2026, 10, 1),
            Decimal("10.1"),
            Decimal("10.1"),
        ),
        (
            "PYTEST_B",
            "USD",
            date(2026, 10, 1),
            Decimal("10.1"),
            Decimal("10.1"),
        ),
    }
    assert result["funds_failed"] == []


def test_crawl_reports_each_failed_history(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        manulife,
        "fetch_manulife_fundslist",
        lambda **_kwargs: {
            "payload": (
                '[{"fundId":"PYTEST_A","fundName":"Fund A"},'
                '{"fundId":"PYTEST_B","fundName":"Fund B"}]'
            ),
            "source": "manulife.fundslist",
            "status_code": 200,
            "fetched_at": "",
        },
    )

    def fake_fetch_history(*, fund_id: str, **_kwargs):
        if fund_id == "PYTEST_A":
            raise ValueError("request failed")
        return {
            "payload": "{}",
            "source": "manulife.fundhistory",
            "status_code": 200,
            "fetched_at": "",
        }

    monkeypatch.setattr(manulife, "fetch_manulife_fundhistory", fake_fetch_history)

    result = manulife.crawl(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
    )

    assert result["records"] == []
    assert {
        (failure["fund_id"], failure["note"])
        for failure in result["funds_failed"]
    } == {
        ("MANULIFE:PYTEST_A", "fundhistory_fetch_failed"),
        ("MANULIFE:PYTEST_B", "fundhistory_parse_failed"),
    }


def test_crawl_rejects_invalid_date_range() -> None:
    with pytest.raises(ValueError, match="from_date must be <= to_date"):
        manulife.crawl(
            from_date=date(2026, 10, 8),
            to_date=date(2026, 10, 7),
        )


@pytest.mark.integration
def test_update_fund(manulife_pg_engine: Engine) -> None:
    fund_id = "MANULIFE:PYTEST_UPDATE"
    _insert_fund(
        manulife_pg_engine,
        fund_id=fund_id,
        provider_code="PYTEST_UPDATE",
        name="Pytest Update Fund",
    )

    with manulife_pg_engine.begin() as connection:
        manulife.update_fund(connection, fund_id)

    with manulife_pg_engine.connect() as connection:
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
def test_is_fund_exists_yes(manulife_pg_engine: Engine) -> None:
    fund_id = "MANULIFE:PYTEST_EXISTING"
    _insert_fund(
        manulife_pg_engine,
        fund_id=fund_id,
        provider_code="PYTEST_EXISTING",
        name="Pytest Existing Fund",
        alias="Pytest Existing Fund",
    )
    record = _price_record(
        fund_id="PYTEST_EXISTING",
        fund_name="Pytest Existing Fund",
        price_date=date(2026, 10, 1),
        price="10.1",
    )

    with manulife_pg_engine.begin() as connection:
        returned_fund_id = manulife.is_fund_exists(connection, record)

    with manulife_pg_engine.connect() as connection:
        row = connection.execute(
            text("""
                SELECT last_seen_at,
                       (SELECT count(*) FROM mpf.fund_aliases WHERE fund_id = :fund_id) AS aliases
                FROM mpf.funds
                WHERE fund_id = :fund_id
                """),
            {"fund_id": fund_id},
        ).one()

    assert returned_fund_id == fund_id
    assert row.last_seen_at.year > 2000
    assert row.aliases == 1


@pytest.mark.integration
def test_is_fund_exists_no(manulife_pg_engine: Engine) -> None:
    record = _price_record(
        fund_id="PYTEST_NEW",
        fund_name="Pytest New Fund",
        currency="USD",
        price_date=date(2026, 10, 1),
        price="10.1",
    )

    with manulife_pg_engine.begin() as connection:
        fund_id = manulife.is_fund_exists(connection, record)

    with manulife_pg_engine.connect() as connection:
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

    assert fund_id == "MANULIFE:PYTEST_NEW"
    assert dict(fund) == {
        "provider": "manulife",
        "provider_fund_code": "PYTEST_NEW",
        "name": "Pytest New Fund",
        "currency": "USD",
    }
    assert aliases == ["Pytest New Fund"]


@pytest.mark.integration
def test_is_fund_exists_no_conflict(manulife_pg_engine: Engine) -> None:
    fund_id = "MANULIFE:PYTEST_CONFLICT"
    _insert_fund(
        manulife_pg_engine,
        fund_id=fund_id,
        provider_code="PYTEST_OLD_CODE",
        name="Old Fund Name",
        currency="HKD",
    )
    record = _price_record(
        fund_id="PYTEST_CONFLICT",
        fund_name="Pytest Conflict Fund",
        currency="USD",
        price_date=date(2026, 10, 1),
        price="10.1",
    )

    with manulife_pg_engine.begin() as connection:
        returned_fund_id = manulife.is_fund_exists(connection, record)

    with manulife_pg_engine.connect() as connection:
        row = connection.execute(
            text("""
                SELECT provider_fund_code, name, currency
                FROM mpf.funds
                WHERE fund_id = :fund_id
                """),
            {"fund_id": fund_id},
        ).mappings().one()
        alias = connection.execute(
            text("SELECT alias FROM mpf.fund_aliases WHERE fund_id = :fund_id"),
            {"fund_id": fund_id},
        ).scalar_one()

    assert returned_fund_id == fund_id
    assert dict(row) == {
        "provider_fund_code": "PYTEST_OLD_CODE",
        "name": "Pytest Conflict Fund",
        "currency": "USD",
    }
    assert alias == "Pytest Conflict Fund"


@pytest.mark.integration
def test_save_records(manulife_pg_engine: Engine) -> None:
    records = [
        _price_record(
            fund_id="PYTEST_SAVE",
            fund_name="Pytest Save Fund",
            price_date=date(2026, 10, 1),
            price="10.1",
        ),
        _price_record(
            fund_id="PYTEST_SAVE",
            fund_name="Pytest Save Fund",
            price_date=date(2026, 10, 2),
            price="10.2",
        ),
    ]

    result = manulife.save_records(manulife_pg_engine, records)

    with manulife_pg_engine.connect() as connection:
        stored_prices = connection.execute(
            text("""
                SELECT price_date, bid, offer, source
                FROM mpf.fund_prices
                WHERE fund_id = 'MANULIFE:PYTEST_SAVE'
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
        (
            date(2026, 10, 1),
            Decimal("10.1000000000"),
            Decimal("10.1000000000"),
            "manulife_fundhistory",
        ),
        (
            date(2026, 10, 2),
            Decimal("10.2000000000"),
            Decimal("10.2000000000"),
            "manulife_fundhistory",
        ),
    ]


@pytest.mark.integration
def test_save_records_conflict(manulife_pg_engine: Engine) -> None:
    original = _price_record(
        fund_id="PYTEST_SAVE_CONFLICT",
        fund_name="Pytest Save Conflict Fund",
        price_date=date(2026, 10, 3),
        price="20.1",
    )
    changed = _price_record(
        fund_id="PYTEST_SAVE_CONFLICT",
        fund_name="Pytest Save Conflict Fund",
        price_date=date(2026, 10, 3),
        price="21.1",
    )

    inserted = manulife.save_records(manulife_pg_engine, [original])
    unchanged = manulife.save_records(manulife_pg_engine, [original])
    updated = manulife.save_records(manulife_pg_engine, [changed])

    with manulife_pg_engine.connect() as connection:
        stored_prices = connection.execute(
            text("""
                SELECT bid, offer
                FROM mpf.fund_prices
                WHERE fund_id = 'MANULIFE:PYTEST_SAVE_CONFLICT'
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
    assert stored_prices == (
        Decimal("21.1000000000"),
        Decimal("21.1000000000"),
    )


def test_crawl(monkeypatch: pytest.MonkeyPatch) -> None:
    funds = [
        manulife.ManulifeFundRecord("PYTEST_A", "Fund A", "HKD"),
        manulife.ManulifeFundRecord("PYTEST_B", "Fund B", "USD"),
    ]
    fetch_manulife_fundslist = Mock(
        return_value={
            "source": "manulife.fundslist",
            "payload": "fund list payload",
            "status_code": 200,
            "fetched_at": "2026-10-13T12:00:00Z",
        }
    )
    parse_manulife_fundslist = Mock(return_value=funds)

    def fake_fetch_fundhistory(*, fund_id: str, **_kwargs):
        return {
            "source": "manulife.fundhistory",
            "payload": f"history payload for {fund_id}",
            "status_code": 200,
            "fetched_at": "2026-10-13T12:00:00Z",
        }

    fetch_manulife_fundhistory = Mock(side_effect=fake_fetch_fundhistory)

    def fake_parse_fundhistory(payload: str, *, expected_fund_id: str):
        assert payload == f"history payload for {expected_fund_id}"
        if expected_fund_id == "PYTEST_A":
            return [
                manulife.FundHistoryPoint(date(2026, 9, 30), Decimal("9.9")),
                manulife.FundHistoryPoint(date(2026, 10, 1), Decimal("10.1")),
                manulife.FundHistoryPoint(date(2026, 10, 2), Decimal("0")),
            ]
        return [
            manulife.FundHistoryPoint(date(2026, 10, 7), Decimal("20.7")),
            manulife.FundHistoryPoint(date(2026, 10, 8), Decimal("20.8")),
        ]

    parse_manulife_fundhistory = Mock(side_effect=fake_parse_fundhistory)
    monkeypatch.setattr(
        manulife, "fetch_manulife_fundslist", fetch_manulife_fundslist
    )
    monkeypatch.setattr(
        manulife, "parse_manulife_fundslist", parse_manulife_fundslist
    )
    monkeypatch.setattr(
        manulife, "fetch_manulife_fundhistory", fetch_manulife_fundhistory
    )
    monkeypatch.setattr(
        manulife, "parse_manulife_fundhistory", parse_manulife_fundhistory
    )

    result = manulife.crawl(
        from_date=date(2026, 10, 1),
        to_date=date(2026, 10, 7),
    )

    assert set(result["records"]) == {
        manulife.ManulifePriceRecord(
            "PYTEST_A",
            "Fund A",
            "HKD",
            date(2026, 10, 1),
            Decimal("10.1"),
            Decimal("10.1"),
        ),
        manulife.ManulifePriceRecord(
            "PYTEST_B",
            "Fund B",
            "USD",
            date(2026, 10, 7),
            Decimal("20.7"),
            Decimal("20.7"),
        ),
    }
    assert result["funds_failed"] == []
    fetch_manulife_fundslist.assert_called_once_with(
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=1.5,
    )
    parse_manulife_fundslist.assert_called_once_with("fund list payload")
    fetch_manulife_fundhistory.assert_has_calls(
        [
            call(
                fund_id="PYTEST_A",
                timeout_seconds=30.0,
                retries=3,
                backoff_seconds=1.5,
            ),
            call(
                fund_id="PYTEST_B",
                timeout_seconds=30.0,
                retries=3,
                backoff_seconds=1.5,
            ),
        ],
        any_order=True,
    )
    assert fetch_manulife_fundhistory.call_count == 2
    parse_manulife_fundhistory.assert_has_calls(
        [
            call("history payload for PYTEST_A", expected_fund_id="PYTEST_A"),
            call("history payload for PYTEST_B", expected_fund_id="PYTEST_B"),
        ],
        any_order=True,
    )
    assert parse_manulife_fundhistory.call_count == 2
