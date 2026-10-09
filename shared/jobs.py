import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.engine import Connection

from shared.models import JobStatus


@dataclass
class JobRecord:
    job_id: UUID
    service: str
    job_type: str
    status: JobStatus
    idempotency_key: str
    request: dict[str, Any]
    result: dict[str, Any]
    attempts: int
    error_message: str | None
    created_at: datetime
    updated_at: datetime


def enqueue_job(
    connection: Connection,
    *,
    service: str,
    job_type: str,
    request_payload: dict[str, Any],
    idempotency_key: str | None,
) -> JobRecord:
    key = idempotency_key or str(uuid4())
    row = connection.execute(
        text(
            """
            INSERT INTO mpf.jobs(service, job_type, status, idempotency_key, request)
            VALUES (:service, :job_type, :status, :idempotency_key, CAST(:request AS JSONB))
            ON CONFLICT (service, idempotency_key)
            DO UPDATE SET request = EXCLUDED.request, updated_at = NOW()
            RETURNING
                job_id, service, job_type, status, idempotency_key, request,
                result, attempts, error_message, created_at, updated_at
            """
        ),
        {
            "service": service,
            "job_type": job_type,
            "status": JobStatus.QUEUED.value,
            "idempotency_key": key,
            "request": json.dumps(request_payload),
        },
    ).mappings().one()
    return _row_to_job(row)


def get_job(connection: Connection, *, service: str, job_id: UUID) -> JobRecord | None:
    row = connection.execute(
        text(
            """
            SELECT
                job_id, service, job_type, status, idempotency_key, request,
                result, attempts, error_message, created_at, updated_at
            FROM mpf.jobs
            WHERE service = :service AND job_id = :job_id
            """
        ),
        {"service": service, "job_id": job_id},
    ).mappings().first()
    if row is None:
        return None
    return _row_to_job(row)


def claim_next_job(
    connection: Connection,
    *,
    service: str,
    lease_seconds: int = 60,
) -> JobRecord | None:
    row = connection.execute(
        text(
            """
            WITH candidate AS (
                SELECT job_id
                FROM mpf.jobs
                WHERE service = :service
                  AND (
                      status = :queued_status
                      OR (status = :running_status AND lease_until IS NOT NULL AND lease_until < NOW())
                  )
                ORDER BY created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE mpf.jobs AS j
            SET
                status = :running_status,
                attempts = j.attempts + 1,
                lease_until = NOW() + (:lease_seconds * INTERVAL '1 second'),
                heartbeat_at = NOW(),
                updated_at = NOW()
            FROM candidate
            WHERE j.job_id = candidate.job_id
            RETURNING
                j.job_id, j.service, j.job_type, j.status, j.idempotency_key, j.request,
                j.result, j.attempts, j.error_message, j.created_at, j.updated_at
            """
        ),
        {
            "service": service,
            "queued_status": JobStatus.QUEUED.value,
            "running_status": JobStatus.RUNNING.value,
            "lease_seconds": lease_seconds,
        },
    ).mappings().first()
    if row is None:
        return None
    return _row_to_job(row)


def heartbeat_job(
    connection: Connection,
    *,
    job_id: UUID,
    lease_seconds: int = 60,
) -> None:
    connection.execute(
        text(
            """
            UPDATE mpf.jobs
            SET heartbeat_at = NOW(),
                lease_until = NOW() + (:lease_seconds * INTERVAL '1 second'),
                updated_at = NOW()
            WHERE job_id = :job_id
            """
        ),
        {"job_id": job_id, "lease_seconds": lease_seconds},
    )


def complete_job(
    connection: Connection,
    *,
    job_id: UUID,
    result_payload: dict[str, Any],
) -> None:
    connection.execute(
        text(
            """
            UPDATE mpf.jobs
            SET
                status = :succeeded_status,
                result = CAST(:result AS JSONB),
                error_message = NULL,
                lease_until = NULL,
                heartbeat_at = NOW(),
                updated_at = NOW()
            WHERE job_id = :job_id
            """
        ),
        {
            "job_id": job_id,
            "succeeded_status": JobStatus.SUCCEEDED.value,
            "result": json.dumps(result_payload),
        },
    )


def fail_job(connection: Connection, *, job_id: UUID, error_message: str) -> None:
    connection.execute(
        text(
            """
            UPDATE mpf.jobs
            SET
                status = :failed_status,
                error_message = :error_message,
                lease_until = NULL,
                heartbeat_at = NOW(),
                updated_at = NOW()
            WHERE job_id = :job_id
            """
        ),
        {
            "job_id": job_id,
            "failed_status": JobStatus.FAILED.value,
            "error_message": error_message[:4000],
        },
    )


def _row_to_job(row: dict[str, Any]) -> JobRecord:
    return JobRecord(
        job_id=row["job_id"],
        service=row["service"],
        job_type=row["job_type"],
        status=JobStatus(row["status"]),
        idempotency_key=row["idempotency_key"],
        request=dict(row["request"] or {}),
        result=dict(row["result"] or {}),
        attempts=row["attempts"],
        error_message=row["error_message"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
