from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from src.libs.crawlers.hsbc import fetch_all_funds_csv, parse_all_funds_csv


pytestmark = pytest.mark.live


def test_live_hsbc_csv_fetch_and_parse_recent_window(live_fetch_options: dict[str, object]) -> None:
    to_date = datetime.now(tz=ZoneInfo("Asia/Hong_Kong")).date()
    from_date = to_date - timedelta(days=7)

    result = fetch_all_funds_csv(
        from_date=from_date, to_date=to_date, **live_fetch_options
    )
    records = parse_all_funds_csv(result["payload"])

    assert result["status_code"] == 200
    assert records, "Expected non-empty HSBC records from live API"
    assert any(from_date <= record.price_date <= to_date for record in records)
    assert len({record.fund_name for record in records}) >= 5
