from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import text

from shared.auth import require_api_key
from shared.db import begin_connection
from shared.jobs import enqueue_job, get_job
from shared.models import JobAcceptedResponse, JobResponse
from services.crawler.app.schemas import BackfillJobRequest, SyncJobRequest

router = APIRouter(prefix="/v1", dependencies=[Depends(require_api_key)], tags=["crawler"])


@router.post(
    "/crawl/jobs/sync",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def create_sync_job(
    payload: SyncJobRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    with begin_connection() as connection:
        job = enqueue_job(
            connection,
            service="crawler",
            job_type="sync",
            request_payload=payload.model_dump(mode="json"),
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )


@router.post(
    "/crawl/jobs/backfill",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def create_backfill_job(
    payload: BackfillJobRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    with begin_connection() as connection:
        job = enqueue_job(
            connection,
            service="crawler",
            job_type="backfill",
            request_payload=payload.model_dump(mode="json"),
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )


@router.get("/crawl/jobs/{job_id}", response_model=JobResponse)
def get_crawl_job(job_id: UUID) -> JobResponse:
    with begin_connection() as connection:
        job = get_job(connection, service="crawler", job_id=job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobResponse(**job.__dict__)


@router.get("/funds")
def list_funds(limit: int = Query(default=200, ge=1, le=1000)) -> dict[str, object]:
    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT fund_id, provider, provider_fund_code, name, currency, last_seen_at
                FROM mpf.funds
                ORDER BY provider, fund_id
                LIMIT :limit
                """
            ),
            {"limit": limit},
        ).mappings().all()
    return {"count": len(rows), "items": [dict(row) for row in rows]}
