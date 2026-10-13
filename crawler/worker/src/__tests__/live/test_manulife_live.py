from __future__ import annotations

import pytest

from src.libs.crawlers.manulife import (
    fetch_manulife_fundhistory,
    fetch_manulife_fundslist,
    parse_manulife_fundhistory,
    parse_manulife_fundslist,
)


pytestmark = pytest.mark.live


def test_live_manulife_fundslist_fetch_and_parse(live_fetch_options: dict[str, object]) -> None:
    result = fetch_manulife_fundslist(**live_fetch_options)
    records = parse_manulife_fundslist(result["payload"])

    assert result["status_code"] == 200
    assert records, "Expected non-empty Manulife funds list from live API"
    assert any(record.fund_id for record in records)


def test_live_manulife_fundhistory_smoke_or_explicit_skip(
    live_fetch_options: dict[str, object],
) -> None:
    fundslist_response = fetch_manulife_fundslist(**live_fetch_options)
    funds = parse_manulife_fundslist(fundslist_response["payload"])
    sample = next((item for item in funds if item.fund_id.strip()), None)
    assert sample is not None, "No candidate fund ID for live fundhistory test"

    history_response = fetch_manulife_fundhistory(fund_id=sample.fund_id, **live_fetch_options)

    assert history_response["status_code"] == 200
    assert history_response["payload"].strip()

    points = parse_manulife_fundhistory(history_response["payload"])

    assert points, "Expected at least one fundhistory point when schema is parseable"
