from __future__ import annotations

import json
from datetime import date
from typing import Any
from uuid import UUID

import pytest

pytestmark = pytest.mark.integration


def test_crawler_sync_idempotent(integration_harness: Any) -> None:
    status, created = integration_harness.api_request(
        service_host="mpf-crawler",
        method="POST",
        path="/v1/crawl/jobs/sync",
        payload={"provider": "all", "rolling_days": 7},
        extra_headers={"Idempotency-Key": "itest-sync-1"},
    )
    assert status == 202
    job = integration_harness.poll_job(
        service_host="mpf-crawler",
        job_path_prefix="/v1/crawl/jobs",
        job_id=created["job_id"],
    )
    assert job["status"] == "succeeded"
    assert job["result"]["funds_seen"] == 96
    assert job["result"]["price_rows_inserted"] == 595
    assert job["result"]["price_rows_updated"] == 0
    assert job["result"]["price_rows_unchanged"] == 0

    valuation_jobs = int(integration_harness.sql_scalar("SELECT count(*) FROM mpf.jobs WHERE service='valuation'"))
    assert valuation_jobs == 0

    status, created = integration_harness.api_request(
        service_host="mpf-crawler",
        method="POST",
        path="/v1/crawl/jobs/sync",
        payload={"provider": "all", "rolling_days": 7},
        extra_headers={"Idempotency-Key": "itest-sync-2"},
    )
    assert status == 202
    job = integration_harness.poll_job(
        service_host="mpf-crawler",
        job_path_prefix="/v1/crawl/jobs",
        job_id=created["job_id"],
    )
    assert job["status"] == "succeeded"
    assert job["result"]["price_rows_inserted"] == 0
    assert job["result"]["price_rows_updated"] == 0
    assert job["result"]["price_rows_unchanged"] == 595

    status, funds_response = integration_harness.api_request(
        service_host="mpf-crawler",
        method="GET",
        path="/v1/funds?limit=200",
    )
    assert status == 200
    assert funds_response["count"] == 96


def test_portfolio_purchase_and_valuation_flow(integration_harness: Any) -> None:
    _, funds_response = integration_harness.api_request(
        service_host="mpf-crawler",
        method="GET",
        path="/v1/funds?limit=200",
    )
    hsbc_funds = [item["fund_id"] for item in funds_response["items"] if item["provider"] == "hsbc"]
    manulife_funds = [item["fund_id"] for item in funds_response["items"] if item["provider"] == "manulife"]
    assert len(hsbc_funds) >= 2
    assert len(manulife_funds) >= 2

    status, hsbc_account = integration_harness.api_request(
        service_host="mpf-portfolio",
        method="POST",
        path="/v1/accounts",
        payload={"provider": "hsbc", "scheme": "HB", "display_label": "ITEST HSBC", "currency": "HKD"},
    )
    assert status == 201
    UUID(hsbc_account["account_id"])

    status, manulife_account = integration_harness.api_request(
        service_host="mpf-portfolio",
        method="POST",
        path="/v1/accounts",
        payload={"provider": "manulife", "scheme": "8", "display_label": "ITEST MANU", "currency": "HKD"},
    )
    assert status == 201
    UUID(manulife_account["account_id"])

    for account_id, fund_pair in (
        (hsbc_account["account_id"], hsbc_funds[:2]),
        (manulife_account["account_id"], manulife_funds[:2]),
    ):
        status, _ = integration_harness.api_request(
            service_host="mpf-portfolio",
            method="POST",
            path=f"/v1/accounts/{account_id}/baselines",
            payload={
                "effective_date": "2026-10-05",
                "source": "itest_seed",
                "verification_status": "VERIFIED",
                "holdings": [
                    {"fund_id": fund_pair[0], "units": "1000.0"},
                    {"fund_id": fund_pair[1], "units": "800.0"},
                ],
            },
        )
        assert status == 202

    _wait_for_holdings(integration_harness, hsbc_account["account_id"], expected_count=2)
    _wait_for_holdings(integration_harness, manulife_account["account_id"], expected_count=2)

    for account_id, fund_pair, amount in (
        (hsbc_account["account_id"], hsbc_funds[:2], "3000.00"),
        (manulife_account["account_id"], manulife_funds[:2], "2500.00"),
    ):
        status, _ = integration_harness.api_request(
            service_host="mpf-portfolio",
            method="PUT",
            path=f"/v1/accounts/{account_id}/allocation-rules",
            payload={
                "effective_from": "2026-10-01",
                "contribution_stream": "employee",
                "allocations": [
                    {"fund_id": fund_pair[0], "weight": "60"},
                    {"fund_id": fund_pair[1], "weight": "40"},
                ],
            },
        )
        assert status == 202

        status, _ = integration_harness.api_request(
            service_host="mpf-portfolio",
            method="PUT",
            path=f"/v1/accounts/{account_id}/contribution-plans",
            payload={
                "contribution_stream": "employee",
                "amount": amount,
                "expected_day": 7,
                "effective_from": "2026-10-01",
            },
        )
        assert status == 202

    _wait_for_active_contribution_plans(integration_harness, expected_count=2)
    _wait_for_allocation_rules(integration_harness, expected_count=4)

    before_tx = int(integration_harness.sql_scalar("SELECT count(*) FROM mpf.purchase_transactions"))
    status, created = integration_harness.api_request(
        service_host="mpf-purchase",
        method="POST",
        path="/v1/purchase/jobs/process-due",
        payload={"as_of_date": "2026-10-07"},
    )
    assert status == 202
    job = integration_harness.poll_job(
        service_host="mpf-purchase",
        job_path_prefix="/v1/purchase/jobs",
        job_id=created["job_id"],
    )
    assert job["status"] == "succeeded"
    assert job["result"]["processed_events"] == 2
    assert job["result"]["inserted_transactions"] == 2
    after_tx = int(integration_harness.sql_scalar("SELECT count(*) FROM mpf.purchase_transactions"))
    assert after_tx - before_tx == 2

    status, created = integration_harness.api_request(
        service_host="mpf-purchase",
        method="POST",
        path="/v1/purchase/jobs/process-due",
        payload={"as_of_date": "2026-10-07"},
    )
    assert status == 202
    job = integration_harness.poll_job(
        service_host="mpf-purchase",
        job_path_prefix="/v1/purchase/jobs",
        job_id=created["job_id"],
    )
    assert job["status"] == "succeeded"
    assert job["result"]["inserted_transactions"] == 0
    after_tx_second = int(integration_harness.sql_scalar("SELECT count(*) FROM mpf.purchase_transactions"))
    assert after_tx_second == after_tx

    before_snapshot = int(integration_harness.sql_scalar("SELECT count(*) FROM mpf.portfolio_snapshots"))
    status, created = integration_harness.api_request(
        service_host="mpf-valuation",
        method="POST",
        path="/v1/valuation/jobs/snapshot",
        payload={"as_of_date": "2026-10-07"},
    )
    assert status == 202
    job = integration_harness.poll_job(
        service_host="mpf-valuation",
        job_path_prefix="/v1/valuation/jobs",
        job_id=created["job_id"],
    )
    assert job["status"] == "succeeded"
    assert job["result"]["saved_accounts"] == 2
    after_snapshot = int(integration_harness.sql_scalar("SELECT count(*) FROM mpf.portfolio_snapshots"))
    assert after_snapshot - before_snapshot == 2

    snapshot_count_before_read = int(integration_harness.sql_scalar("SELECT count(*) FROM mpf.portfolio_snapshots"))
    status, latest = integration_harness.api_request(
        service_host="mpf-valuation",
        method="GET",
        path="/v1/valuation/latest",
    )
    assert status == 200
    snapshot_count_after_read = int(integration_harness.sql_scalar("SELECT count(*) FROM mpf.portfolio_snapshots"))
    assert snapshot_count_after_read == snapshot_count_before_read
    assert latest["calculation_status"] in {"COMPLETE", "STALE", "PARTIAL"}

    status, as_of = integration_harness.api_request(
        service_host="mpf-valuation",
        method="GET",
        path="/v1/valuation/as-of?date=2026-10-07",
    )
    assert status == 200
    requested_as_of = date.fromisoformat(as_of["requested_as_of"])
    for account in as_of["accounts"]:
        for fund in account["funds"]:
            if fund["price_date"] is not None:
                assert date.fromisoformat(fund["price_date"]) <= requested_as_of

    duplicate_price_rows = int(
        integration_harness.sql_scalar(
            "SELECT count(*) FROM (SELECT fund_id, price_date, count(*) c FROM mpf.fund_prices "
            "GROUP BY fund_id, price_date HAVING count(*) > 1) t"
        )
    )
    assert duplicate_price_rows == 0

    duplicate_purchase_rows = int(
        integration_harness.sql_scalar(
            "SELECT count(*) FROM (SELECT event_id, fund_id, count(*) c FROM mpf.purchase_transactions "
            "GROUP BY event_id, fund_id HAVING count(*) > 1) t"
        )
    )
    assert duplicate_purchase_rows == 0


def test_backfill_reports_unverified_fundhistory(integration_harness: Any) -> None:
    status, created = integration_harness.api_request(
        service_host="mpf-crawler",
        method="POST",
        path="/v1/crawl/jobs/backfill",
        payload={
            "provider": "manulife",
            "from_date": "2026-10-01",
            "to_date": "2026-10-07",
            "manulife_filter_days": 14,
        },
        extra_headers={"Idempotency-Key": "itest-backfill-1"},
    )
    assert status == 202
    job = integration_harness.poll_job(
        service_host="mpf-crawler",
        job_path_prefix="/v1/crawl/jobs",
        job_id=created["job_id"],
    )
    assert job["status"] == "succeeded"
    assert len(job["result"]["funds_failed"]) > 0
    first_error = job["result"]["funds_failed"][0]
    assert first_error["note"] == "fundhistory_unverified_or_blocked"


def test_db_role_restrictions(integration_harness: Any) -> None:
    output = integration_harness.compose(
        [
            "exec",
            "-T",
            "mpf-db",
            "psql",
            "-U",
            "mpf_crawler",
            "-d",
            "mpf",
            "-c",
            "INSERT INTO mpf.accounts(provider, scheme, display_label, currency) VALUES ('x','x','x','HKD');",
        ],
        check=False,
    )
    assert output.returncode != 0
    assert "permission denied" in output.stderr.lower()


def test_service_containers_do_not_include_other_service_sources(integration_harness: Any) -> None:
    service_map = {
        "mpf-crawler": "crawler",
        "mpf-portfolio": "portfolio",
        "mpf-purchase": "purchase",
        "mpf-valuation": "valuation",
    }
    script = (
        "import json, os;"
        "services=['crawler','portfolio','purchase','valuation'];"
        "print(json.dumps({name: os.path.isdir(f'/app/services/{name}') for name in services}))"
    )
    for compose_service, owned_service in service_map.items():
        result = integration_harness.compose(
            ["exec", "-T", compose_service, "python", "-c", script]
        )
        present = json.loads(result.stdout.strip())
        for service_name, exists in present.items():
            if service_name == owned_service:
                assert exists is True
            else:
                assert exists is False


def _wait_for_holdings(harness: Any, account_id: str, expected_count: int) -> None:
    for _ in range(30):
        status, body = harness.api_request(
            service_host="mpf-portfolio",
            method="GET",
            path=f"/v1/accounts/{account_id}/holdings",
        )
        if status == 200 and len(body["items"]) >= expected_count:
            return
        import time

        time.sleep(1)
    raise AssertionError(f"Holdings were not populated for account {account_id}")


def _wait_for_active_contribution_plans(harness: Any, expected_count: int) -> None:
    for _ in range(30):
        count = int(harness.sql_scalar("SELECT count(*) FROM mpf.contribution_plans WHERE active = TRUE"))
        if count >= expected_count:
            return
        import time

        time.sleep(1)
    raise AssertionError(f"Active contribution plans did not reach {expected_count}")


def _wait_for_allocation_rules(harness: Any, expected_count: int) -> None:
    for _ in range(30):
        count = int(harness.sql_scalar("SELECT count(*) FROM mpf.allocation_rules"))
        if count >= expected_count:
            return
        import time

        time.sleep(1)
    raise AssertionError(f"Allocation rule rows did not reach {expected_count}")
