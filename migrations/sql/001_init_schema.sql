CREATE SCHEMA IF NOT EXISTS mpf;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS mpf.funds (
    fund_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_fund_code TEXT NOT NULL,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    asset_class TEXT,
    risk_rating TEXT,
    interest_fund_flag BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_fund_code)
);

CREATE TABLE IF NOT EXISTS mpf.fund_aliases (
    alias_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fund_id, alias)
);

CREATE TABLE IF NOT EXISTS mpf.fund_scheme_memberships (
    membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id) ON DELETE CASCADE,
    provider_scheme_code TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fund_id, provider_scheme_code)
);

CREATE TABLE IF NOT EXISTS mpf.fund_prices (
    fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id) ON DELETE CASCADE,
    price_date DATE NOT NULL,
    bid NUMERIC(24, 10),
    offer NUMERIC(24, 10),
    nav NUMERIC(24, 10),
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (fund_id, price_date)
);

CREATE TABLE IF NOT EXISTS mpf.accounts (
    account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    scheme TEXT NOT NULL,
    display_label TEXT NOT NULL,
    currency TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mpf.holdings_baselines (
    baseline_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES mpf.accounts(account_id) ON DELETE CASCADE,
    fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id),
    effective_date DATE NOT NULL,
    units NUMERIC(24, 10) NOT NULL,
    source TEXT NOT NULL,
    verification_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mpf.allocation_rules (
    rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES mpf.accounts(account_id) ON DELETE CASCADE,
    fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id),
    contribution_stream TEXT NOT NULL,
    effective_from DATE NOT NULL,
    effective_to DATE,
    weight NUMERIC(24, 10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mpf.contribution_plans (
    plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES mpf.accounts(account_id) ON DELETE CASCADE,
    contribution_stream TEXT NOT NULL,
    amount NUMERIC(24, 8) NOT NULL,
    expected_day INTEGER NOT NULL CHECK (expected_day BETWEEN 1 AND 31),
    estimation_policy TEXT NOT NULL DEFAULT 'first_price_on_or_after',
    effective_from DATE NOT NULL,
    effective_to DATE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mpf.contribution_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES mpf.contribution_plans(plan_id) ON DELETE CASCADE,
    period DATE NOT NULL,
    expected_date DATE NOT NULL,
    amount NUMERIC(24, 8) NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (plan_id, period)
);

CREATE TABLE IF NOT EXISTS mpf.purchase_transactions (
    transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES mpf.contribution_events(event_id) ON DELETE CASCADE,
    fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id),
    trade_date DATE NOT NULL,
    cash_amount NUMERIC(24, 8) NOT NULL,
    unit_price NUMERIC(24, 10) NOT NULL,
    units_delta NUMERIC(24, 10) NOT NULL,
    status TEXT NOT NULL,
    estimation_policy TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, fund_id)
);

CREATE TABLE IF NOT EXISTS mpf.portfolio_snapshots (
    snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES mpf.accounts(account_id) ON DELETE CASCADE,
    as_of_date DATE NOT NULL,
    total_value NUMERIC(24, 8),
    currency TEXT NOT NULL,
    calculation_status TEXT NOT NULL,
    calculated_at TIMESTAMPTZ NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    stale BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, as_of_date)
);

CREATE TABLE IF NOT EXISTS mpf.snapshot_fund_values (
    snapshot_fund_value_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES mpf.accounts(account_id) ON DELETE CASCADE,
    as_of_date DATE NOT NULL,
    fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id),
    units NUMERIC(24, 10) NOT NULL,
    price_date DATE,
    price_used NUMERIC(24, 10),
    value NUMERIC(24, 8),
    price_status TEXT NOT NULL,
    units_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, as_of_date, fund_id)
);

CREATE TABLE IF NOT EXISTS mpf.jobs (
    job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    idempotency_key TEXT NOT NULL,
    request JSONB NOT NULL DEFAULT '{}'::JSONB,
    result JSONB NOT NULL DEFAULT '{}'::JSONB,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (service, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_jobs_service_status_created
    ON mpf.jobs(service, status, created_at);
CREATE INDEX IF NOT EXISTS idx_fund_prices_price_date
    ON mpf.fund_prices(price_date);
CREATE INDEX IF NOT EXISTS idx_holdings_baselines_account_effective_date
    ON mpf.holdings_baselines(account_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_events_expected_date
    ON mpf.contribution_events(expected_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_as_of
    ON mpf.portfolio_snapshots(as_of_date);

GRANT USAGE ON SCHEMA mpf TO mpf_crawler, mpf_portfolio, mpf_purchase, mpf_valuation;
GRANT CONNECT ON DATABASE mpf TO mpf_crawler, mpf_portfolio, mpf_purchase, mpf_valuation;

GRANT SELECT ON ALL TABLES IN SCHEMA mpf TO mpf_crawler, mpf_portfolio, mpf_purchase, mpf_valuation;

GRANT INSERT, UPDATE, DELETE ON mpf.funds, mpf.fund_aliases, mpf.fund_scheme_memberships, mpf.fund_prices
TO mpf_crawler;

GRANT INSERT, UPDATE, DELETE ON mpf.accounts, mpf.holdings_baselines, mpf.allocation_rules, mpf.contribution_plans
TO mpf_portfolio;

GRANT INSERT, UPDATE, DELETE ON mpf.contribution_events, mpf.purchase_transactions
TO mpf_purchase;

GRANT INSERT, UPDATE, DELETE ON mpf.portfolio_snapshots, mpf.snapshot_fund_values
TO mpf_valuation;

GRANT INSERT, UPDATE, DELETE ON mpf.jobs TO mpf_crawler, mpf_portfolio, mpf_purchase, mpf_valuation;
