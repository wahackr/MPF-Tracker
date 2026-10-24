-- Preserve existing one-to-one switches while allowing any number of fund legs.
CREATE TABLE IF NOT EXISTS mpf.fund_switch_legs (
    switch_id UUID NOT NULL REFERENCES mpf.fund_switches(switch_id) ON DELETE CASCADE,
    fund_id TEXT NOT NULL REFERENCES mpf.funds(fund_id),
    side TEXT NOT NULL CHECK (side IN ('SOLD', 'BOUGHT')),
    units NUMERIC(24, 10) NOT NULL CHECK (units > 0),
    PRIMARY KEY (switch_id, fund_id)
);
INSERT INTO mpf.fund_switch_legs (switch_id, fund_id, side, units)
SELECT switch_id, from_fund_id, 'SOLD', units_sold FROM mpf.fund_switches WHERE from_fund_id IS NOT NULL
UNION ALL
SELECT switch_id, to_fund_id, 'BOUGHT', units_bought FROM mpf.fund_switches WHERE to_fund_id IS NOT NULL
ON CONFLICT (switch_id, fund_id) DO NOTHING;
-- Original columns remain for non-destructive migration; new switches use legs.
ALTER TABLE mpf.fund_switches ALTER COLUMN from_fund_id DROP NOT NULL;
ALTER TABLE mpf.fund_switches ALTER COLUMN to_fund_id DROP NOT NULL;
ALTER TABLE mpf.fund_switches ALTER COLUMN units_sold DROP NOT NULL;
ALTER TABLE mpf.fund_switches ALTER COLUMN units_bought DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fund_switch_legs_fund ON mpf.fund_switch_legs(fund_id, switch_id);
GRANT SELECT ON mpf.fund_switch_legs TO {{CRAWLER_DB_USER}}, {{PORTFOLIO_DB_USER}}, {{PURCHASE_DB_USER}}, {{VALUATION_DB_USER}};
GRANT INSERT ON mpf.fund_switch_legs TO {{PORTFOLIO_DB_USER}};
