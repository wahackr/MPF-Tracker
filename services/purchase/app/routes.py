from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import text

from shared.auth import require_api_key
from shared.db import begin_connection
from shared.jobs import enqueue_job, get_job
from shared.models import JobAcceptedResponse, JobResponse
from services.purchase.app.schemas import PurchaseConfirmRequest, PurchaseProcessRequest

router = APIRouter(prefix="/v1", dependencies=[Depends(require_api_key)], tags=["purchase"])


@router.post(
    "/purchase/jobs/process-due",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def create_process_due_job(
    payload: PurchaseProcessRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    with begin_connection() as connection:
        job = enqueue_job(
            connection,
            service="purchase",
            job_type="process-due",
            request_payload=payload.model_dump(mode="json"),
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )


@router.get("/purchase/jobs/{job_id}", response_model=JobResponse)
def get_purchase_job(job_id: UUID) -> JobResponse:
    with begin_connection() as connection:
        job = get_job(connection, service="purchase", job_id=job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobResponse(**job.__dict__)


@router.get("/purchase/events")
def list_purchase_events() -> dict[str, object]:
    with begin_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT event_id, plan_id, period, expected_date, amount, status, created_at, updated_at
                FROM mpf.contribution_events
                ORDER BY expected_date DESC, created_at DESC
                LIMIT 500
                """
            )
        ).mappings().all()
    return {"count": len(rows), "items": [dict(row) for row in rows]}


@router.post(
    "/purchase/events/{event_id}/confirm",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobAcceptedResponse,
)
def confirm_purchase_event(
    event_id: UUID,
    payload: PurchaseConfirmRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobAcceptedResponse:
    with begin_connection() as connection:
        event_exists = connection.execute(
            text("SELECT 1 FROM mpf.contribution_events WHERE event_id = :event_id"),
            {"event_id": event_id},
        ).first()
        if event_exists is None:
            raise HTTPException(status_code=404, detail="Contribution event not found")
        job = enqueue_job(
            connection,
            service="purchase",
            job_type="confirm-purchase-event",
            request_payload={"event_id": str(event_id), **payload.model_dump(mode="json")},
            idempotency_key=idempotency_key,
        )
    return JobAcceptedResponse(
        job_id=job.job_id,
        service=job.service,
        job_type=job.job_type,
        status=job.status,
    )
