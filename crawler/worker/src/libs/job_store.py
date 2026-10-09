from __future__ import annotations

from typing import Any
from uuid import UUID

from .db import begin_connection
from .job_queue import (
    ClaimedJob,
    claim_next_crawler_job,
    complete_claimed_job,
    fail_claimed_job,
    heartbeat_claim,
)


class DatabaseJobStore:
    def claim(self, lease_seconds: int) -> ClaimedJob | None:
        with begin_connection() as connection:
            return claim_next_crawler_job(connection, lease_seconds=lease_seconds)

    def heartbeat(self, job_id: UUID, attempts: int, lease_seconds: int) -> bool:
        with begin_connection() as connection:
            return heartbeat_claim(
                connection, job_id=job_id, attempts=attempts, lease_seconds=lease_seconds
            )

    def complete(self, job_id: UUID, attempts: int, result_payload: dict[str, Any]) -> bool:
        with begin_connection() as connection:
            return complete_claimed_job(
                connection, job_id=job_id, attempts=attempts, result_payload=result_payload
            )

    def fail(self, job_id: UUID, attempts: int, error_message: str) -> bool:
        with begin_connection() as connection:
            return fail_claimed_job(
                connection, job_id=job_id, attempts=attempts, error_message=error_message
            )
