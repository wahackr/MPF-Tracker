from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Iterable, TypedDict


class PriceUpsertStats(TypedDict):
    inserted: int
    updated: int
    unchanged: int
    min_changed_date: date | None
    max_changed_date: date | None
