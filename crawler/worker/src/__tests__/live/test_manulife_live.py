from __future__ import annotations

import json

import pytest

from src.libs.crawlers.manulife import (
    fetch_manulife_fundhistory,
    fetch_manulife_fundslist,
)


pytestmark = pytest.mark.live
SAMPLE_FUND_ID = "SHK122"


def test_live_manulife_fundslist_endpoint_returns_data(
    live_fetch_options: dict[str, object],
) -> None:
    result = fetch_manulife_fundslist(**live_fetch_options)

    assert result["status_code"] == 200
    assert result["payload"].strip(), "Expected a non-empty Manulife funds list response"

    funds = json.loads(result["payload"])
    assert isinstance(funds, list) and funds
    assert all(isinstance(fund, dict) for fund in funds)
    assert all(
        isinstance(fund.get("fundId"), str) and fund["fundId"].strip()
        for fund in funds
    )
    assert all(
        isinstance(fund.get("fundName"), str) and fund["fundName"].strip()
        for fund in funds
    )


def test_live_manulife_fundhistory_endpoint_returns_data(
    live_fetch_options: dict[str, object],
) -> None:
    result = fetch_manulife_fundhistory(
        fund_id=SAMPLE_FUND_ID,
        **live_fetch_options,
    )

    assert result["status_code"] == 200
    assert result["payload"].strip(), "Expected a non-empty Manulife history response"

    history = json.loads(result["payload"])
    assert isinstance(history, dict)
    assert history.get("fundId") == SAMPLE_FUND_ID
    assert isinstance(history.get("priceHistory"), list) and history["priceHistory"]
    assert all(isinstance(point, dict) for point in history["priceHistory"])
    assert all(
        isinstance(point.get("asOfDate"), str) and point["asOfDate"].strip()
        for point in history["priceHistory"]
    )
    assert all(
        isinstance(point.get("price"), (int, float, str))
        for point in history["priceHistory"]
    )
