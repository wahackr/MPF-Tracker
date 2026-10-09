from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path
import sys
from types import SimpleNamespace


WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs import repository  # type: ignore[import-not-found]


class _FakeExecuteResult:
    def __init__(self, *, mappings_row=None, scalar=None, scalars_list=None) -> None:
        self._mappings_row = mappings_row
        self._scalar = scalar
        self._scalars_list = scalars_list or []

    def mappings(self):
        return SimpleNamespace(first=lambda: self._mappings_row)

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return SimpleNamespace(all=lambda: self._scalars_list)


class _FakeConnection:
    def __init__(self, outputs: list[_FakeExecuteResult]) -> None:
        self._outputs = list(outputs)
        self.calls: list[dict[str, object]] = []

    def execute(self, statement: object, params: dict[str, object] | None = None) -> _FakeExecuteResult:
        self.calls.append({"statement": str(statement), "params": params or {}})
        return self._outputs.pop(0)


def test_slugify_and_json_dump_helpers() -> None:
    assert repository._slugify("  A/b c---d  ") == "A_B_C_D"
    assert repository._slugify("x" * 100) == "X" * 64
    assert repository._json_dump({"漢字": "值", "a": 1}) == '{"漢字":"值","a":1}'


def test_list_manulife_fund_ids_casts_to_strings() -> None:
    connection = _FakeConnection([_FakeExecuteResult(scalars_list=[123, "MANULIFE:ABC"])])
    fund_ids = repository.list_manulife_fund_ids(connection)
    assert fund_ids == ["123", "MANULIFE:ABC"]


def test_upsert_manulife_nav_price_reports_insert_update_or_unchanged() -> None:
    inserted_conn = _FakeConnection([_FakeExecuteResult(mappings_row={"inserted": True})])
    updated_conn = _FakeConnection([_FakeExecuteResult(mappings_row={"inserted": False})])
    unchanged_conn = _FakeConnection([_FakeExecuteResult(mappings_row=None)])

    assert repository.upsert_manulife_nav_price(
        inserted_conn,
        fund_id="MANULIFE:ABC",
        price_date=date(2026, 10, 1),
        nav=Decimal("10.1"),
        source="manulife_fundhistory",
    ) == (True, True)
    assert repository.upsert_manulife_nav_price(
        updated_conn,
        fund_id="MANULIFE:ABC",
        price_date=date(2026, 10, 1),
        nav=Decimal("10.2"),
        source="manulife_fundhistory",
    ) == (False, True)
    assert repository.upsert_manulife_nav_price(
        unchanged_conn,
        fund_id="MANULIFE:ABC",
        price_date=date(2026, 10, 1),
        nav=Decimal("10.2"),
        source="manulife_fundhistory",
    ) == (False, False)
