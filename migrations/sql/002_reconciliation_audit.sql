CREATE TABLE IF NOT EXISTS mpf.reconciliation_records (
    reconciliation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES mpf.accounts(account_id) ON DELETE CASCADE,
    effective_date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT ON mpf.reconciliation_records TO mpf_crawler, mpf_portfolio, mpf_purchase, mpf_valuation;
GRANT INSERT, UPDATE, DELETE ON mpf.reconciliation_records TO mpf_portfolio;

