from __future__ import annotations

import json
from typing import Any, TypedDict
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Connection

MAX_ATTEMPTS = 3


class ClaimedJob(TypedDict):
    job_id: UUID
    job_type: str
    request: dict[str, Any]
    attempts: int
    lease_until: Any


def heartbeat_claim(
    connection: Connection, *, job_id: UUID, attempts: int, lease_seconds: int
) -> bool:
    result = connection.execute(
        text("""
            UPDATE mpf.jobs
            SET heartbeat_at = NOW(),
                lease_until = NOW() + (:lease_seconds * INTERVAL '1 second'),
                updated_at = NOW()
            WHERE job_id = :job_id
              AND status = 'running'
              AND attempts = :attempts
            """),
        {"job_id": str(job_id), "attempts": attempts, "lease_seconds": lease_seconds},
    )
    return result.rowcount > 0


def complete_claimed_job(
    connection: Connection,
    *,
    job_id: UUID,
    attempts: int,
    result_payload: dict[str, Any],
) -> bool:
    result = connection.execute(
        text("""
            UPDATE mpf.jobs
            SET
                status = :status,
                result = CAST(:result AS JSONB),
                error_message = NULL,
                lease_until = NULL,
                heartbeat_at = NOW(),
                updated_at = NOW()
            WHERE job_id = :job_id
              AND status = 'running'
              AND attempts = :attempts
            """),
        {
            "job_id": str(job_id),
            "attempts": attempts,
            "status": "partial" if result_payload.get("funds_failed") else "succeeded",
            "result": json.dumps(result_payload),
        },
    )
    return result.rowcount > 0


def fail_claimed_job(
    connection: Connection, *, job_id: UUID, attempts: int, error_message: str
) -> bool:
    result = connection.execute(
        text("""
            UPDATE mpf.jobs
            SET
                status = :status,
                error_message = :error_message,
                lease_until = CASE WHEN :status = 'queued'
                    THEN NOW() + (:retry_delay_seconds * INTERVAL '1 second')
                    ELSE NULL END,
                heartbeat_at = NOW(),
                updated_at = NOW()
            WHERE job_id = :job_id
              AND status = 'running'
              AND attempts = :attempts
            """),
        {
            "job_id": str(job_id),
            "attempts": attempts,
            "status": "queued" if attempts < MAX_ATTEMPTS else "failed",
            "retry_delay_seconds": 30 * attempts,
            "error_message": error_message[:4000],
        },
    )
    return result.rowcount > 0
