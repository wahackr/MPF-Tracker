from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.crawler.app.parsers import (
    ParseError,
    parse_hsbc_all_funds_csv,
    parse_manulife_fundhistory,
    parse_manulife_fundslist,
)


FIXTURES_DIR = Path("/home/wah/Workspaces/MPF-Tracker/mpf-codex-handoff/fixtures")


def test_hsbc_parser_unpivots_fixture_to_expected_count() -> None:
    payload = (FIXTURES_DIR / "hsbc_all_supertrust_20260901_20261007.csv").read_text(encoding="utf-8")
    records = parse_hsbc_all_funds_csv(payload)
    assert len(records) == 520
    assert len({item.fund_name for item in records}) == 20
    assert len({item.price_date for item in records}) == 26


@pytest.mark.parametrize(
    ("payload", "expected_message"),
    [
        (
            '"","2026-09-01","2026-09-01"\n"Constituent Fund","BID","OFFER"\n"Age 65 Plus Fund","1.0"\n',
            "row 3 width mismatch",
        ),
        (
            '"","2026-09-01","2026-09-01","2026-09-01","2026-09-01"\n'
            '"Constituent Fund","BID","OFFER","BID","OFFER"\n'
            '"Age 65 Plus Fund","1.0","1.0","1.1","1.1"\n',
            "duplicate header pair",
        ),
        (
            '"","2026-13-01","2026-13-01"\n"Constituent Fund","BID","OFFER"\n"Age 65 Plus Fund","1.0","1.0"\n',
            "Invalid date value",
        ),
        (
            '"","2026-09-01","2026-09-01"\n"Constituent Fund","BID","OFFER"\n"Age 65 Plus Fund","abc","1.0"\n',
            "Invalid decimal value",
        ),
        (
            '"","2026-09-01","2026-09-01"\n"Constituent Fund","BID","BID"\n"Age 65 Plus Fund","1.0","1.0"\n',
            "must be BID/OFFER",
        ),
    ],
)
def test_hsbc_parser_negative_cases(payload: str, expected_message: str) -> None:
    with pytest.raises(ParseError) as exc:
        parse_hsbc_all_funds_csv(payload)
    assert expected_message in str(exc.value)


def test_manulife_fundslist_parser_counts_and_special_interest_fund() -> None:
    payload = (FIXTURES_DIR / "manulife_fundslist.json").read_text(encoding="utf-8")
    records = parse_manulife_fundslist(payload)
    assert len(records) == 76

    product_8 = sum(1 for record in records if record.products_id == ["8"])
    product_22 = sum(1 for record in records if record.products_id == ["22"])
    assert product_8 == 31
    assert product_22 == 45

    nav_positive = sum(1 for record in records if record.nav_price and record.nav_price > 0)
    assert nav_positive == 75

    interest_record = next(record for record in records if record.fund_id == "DHK121")
    assert interest_record.nav_price == 0
    assert interest_record.interest_fund_flag is True


def test_manulife_display_frontend_and_as_of_dates_preserved() -> None:
    payload = (FIXTURES_DIR / "manulife_fundslist.json").read_text(encoding="utf-8")
    records = parse_manulife_fundslist(payload)
    assert any(record.display_frontend is True for record in records)
    assert any(record.display_frontend is False for record in records)
    assert any(record.nav_as_of_date is not None for record in records)


def test_manulife_fundhistory_parser_handles_known_shape() -> None:
    known_shape_payload = json.dumps(
        {
            "history": [
                {"date": "2026-10-01", "price": "17.1"},
                {"date": "2026-10-02", "price": "17.2"},
            ]
        }
    )
    history = parse_manulife_fundhistory(known_shape_payload)
    assert len(history) == 2
    assert history[0].price_date.isoformat() == "2026-10-01"
    assert str(history[0].nav) == "17.1"

