from __future__ import annotations

import csv
from datetime import datetime, timedelta
from io import StringIO
from zoneinfo import ZoneInfo

import pytest

from src.libs.crawlers.hsbc import fetch_all_funds_csv


pytestmark = pytest.mark.live


def test_live_hsbc_endpoint_returns_csv(live_fetch_options: dict[str, object]) -> None:
    to_date = datetime.now(tz=ZoneInfo("Asia/Hong_Kong")).date()
    from_date = to_date - timedelta(days=7)

    result = fetch_all_funds_csv(
        from_date=from_date, to_date=to_date, **live_fetch_options
    )

    assert result["status_code"] == 200
    assert result["payload"].strip(), "Expected a non-empty HSBC response"

    rows = list(csv.reader(StringIO(result["payload"].lstrip("\ufeff"))))
    assert len(rows) >= 3, "Expected HSBC headers and at least one fund row"

    column_count = len(rows[0])
    assert column_count >= 3 and (column_count - 1) % 2 == 0
    assert all(len(row) == column_count for row in rows)
    assert rows[1][0].strip() == "Constituent Fund"
    assert rows[1][1:] == ["BID", "OFFER"] * ((column_count - 1) // 2)
    assert all(row[0].strip() for row in rows[2:])
