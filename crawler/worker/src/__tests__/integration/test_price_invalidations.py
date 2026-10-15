from datetime import date
from decimal import Decimal
from pathlib import Path
import sys
from uuid import uuid4

import pytest
from sqlalchemy import text

WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[3]
if str(WORKER_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_PACKAGE_ROOT))

from src.libs.crawlers import hsbc, manulife


@pytest.mark.integration
@pytest.mark.parametrize("provider", ["hsbc", "manulife"])
def test_price_changes_rebuild_later_saved_snapshots(
    provider, crawler_pg_engine, integration_harness
):
    token = uuid4().hex.upper()
    account_id, other_account_id = str(uuid4()), str(uuid4())
    module = hsbc if provider == "hsbc" else manulife
    fund_code = f"INVALIDATION_{token}"
    fund_id = f"{provider.upper()}:{fund_code}"
    other_fund_id = f"{fund_id}_OTHER"

    def record(code, day, price):
        if provider == "hsbc":
            return hsbc.HsbcPriceRecord(
                code, date(2026, 10, day), Decimal(price), Decimal(price)
            )
        return manulife.ManulifePriceRecord(
            code, code, "HKD", date(2026, 10, day), Decimal(price), Decimal(price)
        )

    def api(path, payload):
        status, body = integration_harness.api_request(
            service_host="mpf-valuation", method="POST", path=path, payload=payload
        )
        assert status == 200, body
        return body

    def requests():
        with crawler_pg_engine.connect() as connection:
            return connection.execute(
                text("""
                    SELECT account_id::text, from_date, to_date, source_service,
                        reason, processed_at
                    FROM mpf.snapshot_invalidation_requests
                    WHERE account_id IN (CAST(:account AS UUID), CAST(:other AS UUID))
                    ORDER BY created_at
                    """),
                {"account": account_id, "other": other_account_id},
            ).mappings().all()

    def snapshots(account=account_id):
        with crawler_pg_engine.connect() as connection:
            return connection.execute(
                text("""
                    SELECT as_of_date, total_value, revision, stale
                    FROM mpf.portfolio_snapshots
                    WHERE account_id = CAST(:account AS UUID) ORDER BY as_of_date
                    """),
                {"account": account},
            ).mappings().all()

    try:
        module.save_records(crawler_pg_engine, [
            record(fund_code, 1, "10"), record(f"{fund_code}_OTHER", 1, "20")
        ])
        for account, fund in [(account_id, fund_id), (other_account_id, other_fund_id)]:
            integration_harness.sql_scalar(f"""
                INSERT INTO mpf.accounts (account_id, provider, scheme, display_label, currency)
                VALUES ('{account}', '{provider}', 'test', 'invalidation test', 'HKD');
                INSERT INTO mpf.holdings_baselines (
                    account_id, fund_id, effective_date, units, source, verification_status
                ) VALUES ('{account}', '{fund}', '2026-10-01', 2, 'test', 'VERIFIED');
                """)
            for day in (1, 3, 4):
                api("/v1/valuation/snapshot", {
                    "account_id": account, "as_of_date": f"2026-10-{day:02}"
                })

        assert requests() == []
        assert [row["total_value"] for row in snapshots()] == [Decimal("20")] * 3

        # An inserted price supersedes the older price used by later snapshots.
        for price, expected_stat in [("11", "inserted"), ("12", "updated")]:
            new_record = record(fund_code, 3, price)
            records = [new_record]
            if expected_stat == "inserted":
                # Unsorted changes use the earliest changed date; an older
                # unchanged price must not move that boundary backwards.
                records.extend([record(fund_code, 2, price), record(fund_code, 1, "10")])
            result = module.save_records(crawler_pg_engine, iter(records))
            assert result[expected_stat] == (2 if expected_stat == "inserted" else 1)
            pending = [row for row in requests() if row["processed_at"] is None]
            assert len(pending) == 1
            assert pending[0]["account_id"] == account_id
            assert pending[0]["from_date"] == date(
                2026, 10, 2 if expected_stat == "inserted" else 3
            )
            assert pending[0]["to_date"] is None
            assert pending[0]["source_service"] == "crawler"
            assert pending[0]["reason"] == "fund_price_changed"

            # Repeated and empty crawls do not enqueue more requests.
            assert module.save_records(crawler_pg_engine, [new_record])["unchanged"] == 1
            module.save_records(crawler_pg_engine, [])
            assert len([row for row in requests() if row["processed_at"] is None]) == 1

            rebuilt = api("/v1/valuation/rebuild", {"account_id": account_id})
            assert rebuilt["invalidations_applied"] == 1
            assert rebuilt["rebuilt_dates"] == ["2026-10-03", "2026-10-04"]
            saved = snapshots()
            assert [row["total_value"] for row in saved] == [
                Decimal("20"), Decimal(price) * 2, Decimal(price) * 2
            ]
            assert saved[0]["revision"] == 1
            assert all(not row["stale"] for row in saved)
            assert all(row["revision"] == 1 for row in snapshots(other_account_id))
    finally:
        integration_harness.sql_scalar(f"""
            DELETE FROM mpf.accounts WHERE account_id IN ('{account_id}', '{other_account_id}');
            DELETE FROM mpf.funds WHERE fund_id IN ('{fund_id}', '{other_fund_id}');
            """)
