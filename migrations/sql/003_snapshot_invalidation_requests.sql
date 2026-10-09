CREATE TABLE IF NOT EXISTS mpf.snapshot_invalidation_requests (
    invalidation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_service TEXT NOT NULL,
    reason TEXT NOT NULL,
    account_id UUID REFERENCES mpf.accounts(account_id) ON DELETE CASCADE,
    from_date DATE,
    to_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_snapshot_invalidation_requests_unprocessed
    ON mpf.snapshot_invalidation_requests(processed_at, created_at);

GRANT SELECT ON mpf.snapshot_invalidation_requests TO mpf_crawler, mpf_portfolio, mpf_purchase, mpf_valuation;
GRANT INSERT ON mpf.snapshot_invalidation_requests TO mpf_crawler, mpf_portfolio, mpf_purchase;
GRANT UPDATE, DELETE ON mpf.snapshot_invalidation_requests TO mpf_valuation;

