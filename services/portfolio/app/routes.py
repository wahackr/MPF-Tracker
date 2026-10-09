from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import text

from shared.auth import require_api_key
from shared.db import begin_connection
from shared.jobs import enqueue_job
from shared.models import JobAcceptedResponse
from services.portfolio.app.schemas import (
    AccountResponse,
    AllocationRuleRequest,
    BaselineRequest,
    ContributionPlanRequest,
    CreateAccountRequest,
    ReconciliationRequest,
)

router = APIRouter(prefix="/v1", dependencies=[Depends(require_api_key)], tags=["portfolio"])


def _ensure_account_exists(account_id: UUID) -> None:
    with begin_connection() as connection:
        account = connection.execute(
            text("SELECT 1 FROM mpf.accounts WHERE account_id = :account_id"),
            {"account_id": account_id},
        ).first()
    if account is None:
        raise HTTPException(status_code=404, detail="Account not found")


@router.post("/accounts", response_model=AccountResponse, status_code=status.HTTP_201_CREATED)
def create_account(payload: CreateAccountRequest) -> AccountResponse:
    with begin_connection() as connection:
        row = connection.execute(
            text(
                """
                INSERT INTO mpf.accounts(provider, scheme, display_label, currency)
                VALUES (:provider, :scheme, :display_label, :currency)
                RETURNING account_id, provider, scheme, display_label, currency, active
                """
            ),
            payload.model_dump(),
        ).mappings().one()
    return AccountResponse(**row)


@router.get("/accounts", response_model=list[AccountResponse])
def list_accounts() -> list[AccountResponse]:
    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT account_id, provider, scheme, display_label, currency, active
                FROM mpf.accounts
                ORDER BY created_at DESC
                """
            )
        ).mappings().all()
    return [AccountResponse(**row) for row in rows]


@router.post(
    "/accounts/{account_id}/baselines",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def create_baseline_job(
    account_id: UUID,
    payload: BaselineRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    _ensure_account_exists(account_id)
    with begin_connection() as connection:
        job = enqueue_job(
            connection,
            service="portfolio",
            job_type="record-baseline",
            request_payload={"account_id": str(account_id), **payload.model_dump(mode="json")},
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )


@router.get("/accounts/{account_id}/holdings")
def list_holdings(account_id: UUID) -> dict[str, object]:
    _ensure_account_exists(account_id)
    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT baseline_id, fund_id, effective_date, units, source, verification_status, created_at
                FROM mpf.holdings_baselines
                WHERE account_id = :account_id
                ORDER BY effective_date DESC, created_at DESC
                """
            ),
            {"account_id": account_id},
        ).mappings().all()
    return {"account_id": account_id, "items": [dict(row) for row in rows]}


@router.put(
    "/accounts/{account_id}/allocation-rules",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def publish_allocation_rules(
    account_id: UUID,
    payload: AllocationRuleRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    _ensure_account_exists(account_id)
    with begin_connection() as connection:
        job = enqueue_job(
            connection,
            service="portfolio",
            job_type="publish-allocation-rules",
            request_payload={"account_id": str(account_id), **payload.model_dump(mode="json")},
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )


@router.put(
    "/accounts/{account_id}/contribution-plans",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def set_contribution_plan(
    account_id: UUID,
    payload: ContributionPlanRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    _ensure_account_exists(account_id)
    with begin_connection() as connection:
        job = enqueue_job(
            connection,
            service="portfolio",
            job_type="set-contribution-plan",
            request_payload={"account_id": str(account_id), **payload.model_dump(mode="json")},
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )


@router.post(
    "/accounts/{account_id}/reconciliations",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def create_reconciliation_job(
    account_id: UUID,
    payload: ReconciliationRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    _ensure_account_exists(account_id)
    with begin_connection() as connection:
        job = enqueue_job(
            connection,
            service="portfolio",
            job_type="reconcile-holdings",
            request_payload={"account_id": str(account_id), **payload.model_dump(mode="json")},
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )
