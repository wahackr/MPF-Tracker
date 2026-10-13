from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

REPO_ROOT = Path(__file__).resolve().parents[5]
WORKER_SRC_DIR = REPO_ROOT / "crawler" / "worker"
if str(WORKER_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC_DIR))

from src.libs.crawlers.manulife import (  # type: ignore[import-not-found]
    parse_manulife_fundhistory,
    parse_manulife_fundslist,
)
from src.libs.crawlers.hsbc import ParseError, parse_all_funds_csv  # type: ignore[import-not-found]


FIXTURES_DIR = REPO_ROOT / "mpf-codex-handoff" / "fixtures"


def test_hsbc_parser_unpivots_fixture_to_expected_count() -> None:
    payload = (FIXTURES_DIR / "hsbc_all_supertrust_20260901_20261007.csv").read_text(encoding="utf-8")
    records = parse_all_funds_csv(payload)
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
        parse_all_funds_csv(payload)
    assert expected_message in str(exc.value)


def test_manulife_fundslist_parser_extracts_fund_identity() -> None:
    payload = (FIXTURES_DIR / "manulife_fundslist.json").read_text(encoding="utf-8")
    records = parse_manulife_fundslist(payload)
    assert len(records) == 76

    fund = next(record for record in records if record.fund_id == "DIS148")
    assert fund.fund_name == "Manulife MPF Core Accumulation Fund ##"
    assert fund.currency == "HKD"


def test_manulife_fundslist_defaults_missing_currency_to_hkd() -> None:
    records = parse_manulife_fundslist(
        '[{"fundId":"SHK122","fundName":"Stable Fund"}]'
    )
    assert records[0].currency == "HKD"


def test_manulife_fundhistory_parser_handles_price_history() -> None:
    payload = json.dumps(
        {
            "priceHistory": [
                {"asOfDate": "2026-10-01", "price": "17.1"},
                {"asOfDate": "2026-10-02", "price": "17.2"},
            ]
        }
    )
    history = parse_manulife_fundhistory(payload)
    assert len(history) == 2
    assert history[0].price_date.isoformat() == "2026-10-01"
    assert str(history[0].price) == "17.1"


def test_manulife_fundhistory_parser_handles_price_history_shape() -> None:
    payload = json.dumps(
        {
            "fundId": "SHK122",
            "priceHistory": [
                {"asOfDate": "2026-10-01", "price": 10.1},
                {"asOfDate": "2026-10-02", "price": 10.2},
            ],
        }
    )
    history = parse_manulife_fundhistory(payload)
    assert len(history) == 2
    assert history[0].price_date.isoformat() == "2026-10-01"
    assert str(history[0].price) == "10.1"
