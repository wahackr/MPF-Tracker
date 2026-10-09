from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Connection


@dataclass
class ClaimedJob:
    job_id: UUID
    job_type: str
    request: dict[str, Any]
    attempts: int
    lease_until: datetime | None


def claim_next_crawler_job(connection: Connection, *, lease_seconds: int) -> ClaimedJob | None:
    row = connection.execute(
        text(
            """
            WITH candidate AS (
                SELECT job_id
                FROM mpf.jobs
                WHERE service = 'crawler'
                  AND (
                      status = 'queued'
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
        {"lease_seconds": lease_seconds},
    ).mappings().first()
    if row is None:
        return None
    return ClaimedJob(
        job_id=row["job_id"],
        job_type=row["job_type"],
        request=dict(row["request"] or {}),
        attempts=int(row["attempts"]),
        lease_until=row["lease_until"],
    )


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
                status = 'succeeded',
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
        {"job_id": str(job_id), "attempts": attempts, "result": json.dumps(result_payload)},
    )
    return result.rowcount > 0


def fail_claimed_job(connection: Connection, *, job_id: UUID, attempts: int, error_message: str) -> bool:
    result = connection.execute(
        text(
            """
            UPDATE mpf.jobs
            SET
                status = 'failed',
                error_message = :error_message,
                lease_until = NULL,
                heartbeat_at = NOW(),
                updated_at = NOW()
            WHERE job_id = :job_id
              AND status = 'running'
              AND attempts = :attempts
            """
        ),
        {"job_id": str(job_id), "attempts": attempts, "error_message": error_message[:4000]},
    )
    return result.rowcount > 0
