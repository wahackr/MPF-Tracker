from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class CreateAccountRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=64)
    scheme: str = Field(min_length=1, max_length=64)
    display_label: str = Field(min_length=1, max_length=255)
    currency: str = Field(default="HKD", min_length=3, max_length=3)


class AccountResponse(BaseModel):
    account_id: UUID
    provider: str
    scheme: str
    display_label: str
    currency: str
    active: bool


class BaselineRequest(BaseModel):
    effective_date: date
    source: str = Field(min_length=1, max_length=64)
    verification_status: str = Field(min_length=1, max_length=32)
    holdings: list[dict[str, Any]]


class AllocationRuleRequest(BaseModel):
    effective_from: date
    effective_to: date | None = None
    contribution_stream: str = Field(min_length=1, max_length=32)
    allocations: list[dict[str, Any]]


class ContributionPlanRequest(BaseModel):
    contribution_stream: str = Field(min_length=1, max_length=32)
    amount: Decimal
    expected_day: int = Field(ge=1, le=31)
    effective_from: date
    effective_to: date | None = None


class ReconciliationRequest(BaseModel):
    effective_date: date
    notes: str | None = None
    holdings: list[dict[str, Any]]
