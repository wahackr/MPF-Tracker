-- Completed, same-account fund switches are portfolio inputs, not contributions.
CREATE TABLE IF NOT EXISTS mpf.fund_switches (
    switch_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES mpf.accounts(account_id) ON DELETE CASCADE,
    trade_date DATE NOT NULL,
    from_fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id),
    to_fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id),
    units_sold NUMERIC(24, 10) NOT NULL CHECK (units_sold > 0),
    units_bought NUMERIC(24, 10) NOT NULL CHECK (units_bought > 0),
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (from_fund_id <> to_fund_id)
);
CREATE INDEX IF NOT EXISTS idx_fund_switches_account_date
    ON mpf.fund_switches(account_id, trade_date);
GRANT SELECT ON mpf.fund_switches TO {{CRAWLER_DB_USER}}, {{PORTFOLIO_DB_USER}}, {{PURCHASE_DB_USER}}, {{VALUATION_DB_USER}};
GRANT INSERT ON mpf.fund_switches TO {{PORTFOLIO_DB_USER}};
