from datetime import date
from typing import Any
from uuid import UUID

from pydantic import BaseModel


class PurchaseProcessRequest(BaseModel):
    as_of_date: date | None = None
    account_id: UUID | None = None


class PurchaseConfirmRequest(BaseModel):
    trade_date: date
    notes: str | None = None
    transactions: list[dict[str, Any]]
