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


def claim_next_crawler_job(connection: Connection, *, lease_seconds: int) -> ClaimedJob | None:
    row = connection.execute(
        text(
            """
            WITH exhausted AS (
                UPDATE mpf.jobs
                SET status = 'failed', lease_until = NULL,
                    error_message = COALESCE(error_message, 'Worker lease expired after maximum attempts'),
                    updated_at = NOW()
                WHERE service = 'crawler' AND status = 'running'
                  AND lease_until < NOW() AND attempts >= :max_attempts
                RETURNING job_id
            ), candidate AS (
                SELECT job_id
                FROM mpf.jobs
                WHERE service = 'crawler'
                  AND attempts < :max_attempts
                  AND (
                      (status = 'queued' AND (lease_until IS NULL OR lease_until <= NOW()))
                      OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < NOW())
                  )
                ORDER BY created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE mpf.jobs AS j
            SET
                status = 'running',
                attempts = j.attempts + 1,
                lease_until = NOW() + (:lease_seconds * INTERVAL '1 second'),
                heartbeat_at = NOW(),
                updated_at = NOW(),
                error_message = NULL
            FROM candidate
            WHERE j.job_id = candidate.job_id
            RETURNING j.job_id, j.job_type, j.request, j.attempts, j.lease_until
            """
        ),
        {"lease_seconds": lease_seconds, "max_attempts": MAX_ATTEMPTS},
    ).mappings().first()
    if row is None:
        return None
    return {
        "job_id": row["job_id"],
        "job_type": row["job_type"],
        "request": dict(row["request"] or {}),
        "attempts": int(row["attempts"]),
        "lease_until": row["lease_until"],
    }


def heartbeat_claim(connection: Connection, *, job_id: UUID, attempts: int, lease_seconds: int) -> bool:
    result = connection.execute(
        text(
            """
            UPDATE mpf.jobs
            SET heartbeat_at = NOW(),
                lease_until = NOW() + (:lease_seconds * INTERVAL '1 second'),
                updated_at = NOW()
            WHERE job_id = :job_id
              AND status = 'running'
              AND attempts = :attempts
            """
        ),
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
        text(
            """
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
            """
        ),
        {
            "job_id": str(job_id),
            "attempts": attempts,
            "status": "partial" if result_payload.get("funds_failed") else "succeeded",
            "result": json.dumps(result_payload),
        },
    )
    return result.rowcount > 0


def fail_claimed_job(connection: Connection, *, job_id: UUID, attempts: int, error_message: str) -> bool:
    result = connection.execute(
        text(
            """
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
            """
        ),
        {
            "job_id": str(job_id),
            "attempts": attempts,
            "status": "queued" if attempts < MAX_ATTEMPTS else "failed",
            "retry_delay_seconds": 30 * attempts,
            "error_message": error_message[:4000],
        },
    )
    return result.rowcount > 0
