from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class HealthResponse(BaseModel):
    service: str
    status: str
    database: str
    checked_at: datetime


class JobAcceptedResponse(BaseModel):
    job_id: UUID
    service: str
    job_type: str
    status: JobStatus


class JobResponse(BaseModel):
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
