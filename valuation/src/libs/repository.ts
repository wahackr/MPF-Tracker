import { query, withTransaction } from "./db.js";
import type { CalculationResult } from "../main.js";

export async function persistSnapshot(calculation: CalculationResult): Promise<{ saved_accounts: number }> {
  if (calculation.accounts.length === 0) return { saved_accounts: 0 };

  return withTransaction(async (client) => {
    // Save all account totals together, increasing each existing snapshot's revision.
    const accounts = calculation.accounts.map((account) => ({
      account_id: account.account_id,
      total_value: account.total_value,
      currency: account.currency,
      calculation_status: account.calculation_status,
      stale: ["STALE", "PARTIAL"].includes(account.calculation_status)
    }));

    await client.query(
      `INSERT INTO mpf.portfolio_snapshots (
         account_id, as_of_date, total_value, currency, calculation_status, calculated_at, revision, stale
       )
       SELECT account_id, $2::date, total_value, currency, calculation_status, NOW(), 1, stale
       FROM jsonb_to_recordset($1::jsonb) AS a(
         account_id uuid, total_value numeric, currency text, calculation_status text, stale boolean
       )
       ON CONFLICT (account_id, as_of_date) DO UPDATE SET
         total_value = EXCLUDED.total_value, currency = EXCLUDED.currency,
         calculation_status = EXCLUDED.calculation_status, calculated_at = NOW(),
         stale = EXCLUDED.stale, revision = mpf.portfolio_snapshots.revision + 1, updated_at = NOW()`,
      [JSON.stringify(accounts), calculation.requested_as_of]
    );

    // Replace the complete fund set for these accounts and this date in the same transaction.
    await client.query(
      "DELETE FROM mpf.snapshot_fund_values WHERE account_id = ANY($1::uuid[]) AND as_of_date = $2::date",
      [accounts.map((account) => account.account_id), calculation.requested_as_of]
    );

    const funds = calculation.accounts.flatMap((account) => account.funds.map((fund) => ({
      account_id: account.account_id,
      fund_id: fund.fund_id,
      units: fund.units,
      price_date: fund.price_date,
      price_used: fund.price,
      value: fund.market_value,
      price_status: fund.price_status,
      units_status: fund.units_status
    })));

    await client.query(
      `INSERT INTO mpf.snapshot_fund_values (
         account_id, as_of_date, fund_id, units, price_date, price_used, value, price_status, units_status
       )
       SELECT account_id, $2::date, fund_id, units, price_date, price_used, value, price_status, units_status
       FROM jsonb_to_recordset($1::jsonb) AS f(
         account_id uuid, fund_id text, units numeric, price_date date, price_used numeric,
         value numeric, price_status text, units_status text
       )`,
      [JSON.stringify(funds), calculation.requested_as_of]
    );

    return { saved_accounts: accounts.length };
  });
}

export async function applyPendingInvalidations(accountId?: string): Promise<number> {
  return withTransaction(async (client) => {
    // Lock pending requests so another worker cannot process the same batch concurrently.
    const requests = (await client.query<{
      invalidation_id: string;
      account_id: string | null;
      from_date: string | null;
      to_date: string | null;
    }>(
      `SELECT invalidation_id::text, account_id::text, from_date::text, to_date::text
       FROM mpf.snapshot_invalidation_requests
       WHERE processed_at IS NULL AND ($1::uuid IS NULL OR account_id = $1::uuid)
       ORDER BY created_at FOR UPDATE SKIP LOCKED`,
      [accountId ?? null]
    )).rows;

    if (requests.length === 0) return 0;

    // Apply all account/date ranges together; null fields intentionally leave that bound open.
    await client.query(
      `UPDATE mpf.portfolio_snapshots s SET stale = TRUE, updated_at = NOW()
       WHERE EXISTS (
         SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS r(account_id uuid, from_date date, to_date date)
         WHERE (r.account_id IS NULL OR s.account_id = r.account_id)
           AND (r.from_date IS NULL OR s.as_of_date >= r.from_date)
           AND (r.to_date IS NULL OR s.as_of_date <= r.to_date)
       )`,
      [JSON.stringify(requests)]
    );

    await client.query(
      "UPDATE mpf.snapshot_invalidation_requests SET processed_at = NOW() WHERE invalidation_id = ANY($1::uuid[])",
      [requests.map((request) => request.invalidation_id)]
    );

    return requests.length;
  });
}

export async function listStaleSnapshotDates(accountId?: string): Promise<string[]> {
  const params: unknown[] = [];
  let accountFilter = "";
  if (accountId) {
    accountFilter = "AND account_id = $1::uuid";
    params.push(accountId);
  }
  const rows = await query<{ as_of_date: string }>(
    `
    SELECT DISTINCT as_of_date::text
    FROM mpf.portfolio_snapshots
    WHERE stale = TRUE
      ${accountFilter}
    ORDER BY as_of_date
    `,
    params
  );
  return rows.rows.map((row) => row.as_of_date);
}

export async function listSnapshotDatesInRange(
  fromDate?: string,
  toDate?: string,
  accountId?: string
): Promise<string[]> {
  const params: unknown[] = [fromDate ?? null, toDate ?? null];
  let accountFilter = "";
  if (accountId) {
    accountFilter = "AND account_id = $3::uuid";
    params.push(accountId);
  }
  const rows = await query<{ as_of_date: string }>(
    `
    SELECT DISTINCT as_of_date::text
    FROM mpf.portfolio_snapshots
    WHERE ($1::date IS NULL OR as_of_date >= $1::date)
      AND ($2::date IS NULL OR as_of_date <= $2::date)
      ${accountFilter}
    ORDER BY as_of_date
    `,
    params
  );
  return rows.rows.map((row) => row.as_of_date);
}

export async function snapshotHistory(fromDate?: string, toDate?: string, accountId?: string): Promise<unknown[]> {
  const params: unknown[] = [fromDate ?? null, toDate ?? null];
  let accountFilter = "";
  if (accountId) {
    accountFilter = "AND account_id = $3::uuid";
    params.push(accountId);
  }
  const rows = await query(
    `
    SELECT account_id::text, as_of_date::text, total_value, currency, calculation_status, calculated_at, revision
    FROM mpf.portfolio_snapshots
    WHERE ($1::date IS NULL OR as_of_date >= $1::date)
      AND ($2::date IS NULL OR as_of_date <= $2::date)
      ${accountFilter}
    ORDER BY as_of_date DESC, calculated_at DESC
    LIMIT 1000
    `,
    params
  );
  return rows.rows;
}
