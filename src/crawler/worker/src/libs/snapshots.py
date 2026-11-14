from datetime import date

from sqlalchemy import text
from sqlalchemy.engine import Connection


def invalidate_price_snapshots(
    connection: Connection, changed_funds: dict[str, date]
) -> None:
    """Queue invalidations in the price transaction for affected saved accounts."""
    for fund_id, from_date in changed_funds.items():
        # A price can be carried forward to any later snapshot. Leave to_date
        # open, including when only one historical price was corrected.
        connection.execute(
            text("""
                INSERT INTO mpf.snapshot_invalidation_requests (
                    source_service, reason, account_id, from_date
                )
                SELECT DISTINCT 'crawler', 'fund_price_changed', account_id,
                    CAST(:from_date AS DATE)
                FROM mpf.snapshot_fund_values
                WHERE fund_id = :fund_id AND as_of_date >= :from_date
                """),
            {"fund_id": fund_id, "from_date": from_date},
        )
