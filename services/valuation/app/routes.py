from datetime import date, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import text

from shared.auth import require_api_key
from shared.db import begin_connection
from shared.jobs import enqueue_job, get_job
from shared.models import JobAcceptedResponse, JobResponse
from services.valuation.app.calculations import calculate_portfolio_as_of
from services.valuation.app.schemas import RebuildJobRequest, SnapshotJobRequest

router = APIRouter(prefix="/v1", dependencies=[Depends(require_api_key)], tags=["valuation"])


@router.post(
    "/valuation/jobs/snapshot",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def create_snapshot_job(
    payload: SnapshotJobRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    with begin_connection() as connection:
        job = enqueue_job(
            connection,
            service="valuation",
            job_type="snapshot",
            request_payload=payload.model_dump(mode="json"),
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )


@router.get("/valuation/jobs/{job_id}", response_model=JobResponse)
def get_valuation_job(job_id: UUID) -> JobResponse:
    with begin_connection() as connection:
        job = get_job(connection, service="valuation", job_id=job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobResponse(**job.__dict__)


@router.get("/valuation/latest")
def get_latest_valuation(
    account_id: UUID | None = Query(default=None),
    include_estimated: bool = Query(default=True),
) -> dict[str, object]:
    as_of = datetime.utcnow().date()
    return calculate_portfolio_as_of(
        as_of_date=as_of,
        account_id=account_id,
        include_estimated=include_estimated,
    )


@router.get("/valuation/as-of")
def get_as_of_valuation(
    target_date: date = Query(alias="date"),
    account_id: UUID | None = Query(default=None),
    include_estimated: bool = Query(default=True),
) -> dict[str, object]:
    return calculate_portfolio_as_of(
        as_of_date=target_date,
        account_id=account_id,
        include_estimated=include_estimated,
    )


@router.get("/valuation/history")
def get_snapshot_history(
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    account_id: UUID | None = Query(default=None),
) -> dict[str, object]:
    query = """
        SELECT account_id, as_of_date, total_value, currency, calculation_status, calculated_at, revision
        FROM mpf.portfolio_snapshots
        WHERE (:from_date IS NULL OR as_of_date >= :from_date)
          AND (:to_date IS NULL OR as_of_date <= :to_date)
          {account_filter}
        ORDER BY as_of_date DESC, calculated_at DESC
        LIMIT 1000
    """
    account_filter = "TRUE"
    params: dict[str, object] = {"from_date": from_date, "to_date": to_date}
    if account_id:
        account_filter = "account_id = :account_id"
        params["account_id"] = str(account_id)
    with begin_connection() as connection:
        rows = connection.execute(
            text(query.format(account_filter=account_filter)),
            params,
        ).mappings().all()
    return {"count": len(rows), "items": [dict(row) for row in rows]}


@router.post(
    "/valuation/jobs/rebuild",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def create_rebuild_job(
    payload: RebuildJobRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    with begin_connection() as connection:
        job = enqueue_job(
            connection,
            service="valuation",
            job_type="rebuild",
            request_payload=payload.model_dump(mode="json"),
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )
