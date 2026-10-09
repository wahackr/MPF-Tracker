from datetime import date
from uuid import UUID

from pydantic import BaseModel


class SnapshotJobRequest(BaseModel):
    as_of_date: date | None = None
    account_id: UUID | None = None


class RebuildJobRequest(BaseModel):
    from_date: date | None = None
    to_date: date | None = None
    account_id: UUID | None = None
