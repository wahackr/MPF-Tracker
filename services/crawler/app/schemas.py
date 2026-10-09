from datetime import date
from enum import Enum

from pydantic import BaseModel, Field


class Provider(str, Enum):
    ALL = "all"
    HSBC = "hsbc"
    MANULIFE = "manulife"


class SyncJobRequest(BaseModel):
    provider: Provider = Provider.ALL
    rolling_days: int = Field(default=7, ge=1, le=28)


class BackfillJobRequest(BaseModel):
    provider: Provider = Provider.ALL
    from_date: date
    to_date: date
    manulife_filter_days: int = Field(default=14, ge=1, le=90)
