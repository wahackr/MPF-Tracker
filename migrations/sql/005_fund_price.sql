-- Store history-sourced Manulife amounts as prices and preserve existing history values.
ALTER TABLE mpf.fund_prices ADD COLUMN IF NOT EXISTS price NUMERIC(24, 10);

-- Funds-list values are not a price source; retain only history-sourced Manulife rows.
DELETE FROM mpf.fund_prices WHERE source = 'manulife_fundslist';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'mpf'
          AND table_name = 'fund_prices'
          AND column_name = 'nav'
    ) THEN
        EXECUTE 'UPDATE mpf.fund_prices SET price = nav WHERE price IS NULL AND nav IS NOT NULL';
        ALTER TABLE mpf.fund_prices DROP COLUMN nav;
    END IF;
END
$$;
