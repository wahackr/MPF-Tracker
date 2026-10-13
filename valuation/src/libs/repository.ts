import { query, withTransaction } from "./db.js";
import type { HoldingRow } from "./rules.js";
import type { CalculationResult } from "../main.js";

export async function loadHoldings(asOfDate: string, accountId?: string): Promise<HoldingRow[]> {
  const params: unknown[] = [asOfDate];
  let accountFilter = "";
  if (accountId) {
    accountFilter = "AND hb.account_id = $2::uuid";
    params.push(accountId);
  }
  const rows = await query<HoldingRow>(
    `
    WITH latest_baselines AS (
      SELECT
        hb.account_id,
        hb.fund_id,
        hb.effective_date,
        hb.units,
        hb.verification_status,
        ROW_NUMBER() OVER (
          PARTITION BY hb.account_id, hb.fund_id
          ORDER BY hb.effective_date DESC, hb.created_at DESC, hb.baseline_id DESC
        ) AS rn
      FROM mpf.holdings_baselines hb
      WHERE hb.effective_date <= $1::date
        ${accountFilter}
    )
    SELECT
      b.account_id::text,
      b.fund_id,
      b.effective_date::text,
      b.units::text,
      b.verification_status,
      COALESCE(SUM(CASE WHEN pt.status = 'CONFIRMED' THEN pt.units_delta ELSE 0 END), 0)::text AS confirmed_delta,
      COALESCE(SUM(CASE WHEN pt.status = 'ESTIMATED' THEN pt.units_delta ELSE 0 END), 0)::text AS estimated_delta
    FROM latest_baselines b
    LEFT JOIN mpf.contribution_plans cp ON cp.account_id = b.account_id
    LEFT JOIN mpf.contribution_events ce ON ce.plan_id = cp.plan_id
    LEFT JOIN mpf.purchase_transactions pt
      ON pt.event_id = ce.event_id
      AND pt.fund_id = b.fund_id
      AND pt.trade_date > b.effective_date
      AND pt.trade_date <= $1::date
    WHERE b.rn = 1
    GROUP BY b.account_id, b.fund_id, b.effective_date, b.units, b.verification_status
    ORDER BY b.account_id, b.fund_id
    `,
    params
  );
  return rows.rows as HoldingRow[];
}

export async function loadLatestPrice(fundId: string, asOfDate: string): Promise<{
  price_date: string;
  price: string;
  price_type: string;
} | null> {
  const row = await query<{ price_date: string; price: string | null; price_type: string }>(
    `
    SELECT
      fp.price_date::text,
      fp.bid::text AS price,
      CASE
        WHEN fp.bid IS NOT NULL THEN 'BID'
        WHEN fp.offer IS NOT NULL THEN 'OFFER'
        ELSE 'UNKNOWN'
      END AS price_type
    FROM mpf.fund_prices fp
    WHERE fp.fund_id = $1
      AND fp.price_date <= $2::date
    ORDER BY fp.price_date DESC
    LIMIT 1
    `,
    [fundId, asOfDate]
  );
  if (row.rows.length === 0 || row.rows[0].price === null) {
    return null;
  }
  return row.rows[0] as { price_date: string; price: string; price_type: string };
}

export async function persistSnapshot(calculation: CalculationResult): Promise<{ saved_accounts: number }> {
  return withTransaction(async (client) => {
    let saved = 0;
    for (const account of calculation.accounts) {
      await client.query(
        `
        INSERT INTO mpf.portfolio_snapshots (
          account_id, as_of_date, total_value, currency, calculation_status, calculated_at, revision, stale
        )
        VALUES ($1::uuid, $2::date, $3::numeric, $4, $5, NOW(), 1, $6)
        ON CONFLICT (account_id, as_of_date)
        DO UPDATE SET
          total_value = EXCLUDED.total_value,
          currency = EXCLUDED.currency,
          calculation_status = EXCLUDED.calculation_status,
          calculated_at = NOW(),
          stale = EXCLUDED.stale,
          revision = mpf.portfolio_snapshots.revision + 1,
          updated_at = NOW()
        `,
        [
          account.account_id,
          calculation.requested_as_of,
          account.total_value,
          account.currency,
          account.calculation_status,
          ["STALE", "PARTIAL"].includes(account.calculation_status)
        ]
      );

      await client.query(
        `DELETE FROM mpf.snapshot_fund_values WHERE account_id = $1::uuid AND as_of_date = $2::date`,
        [account.account_id, calculation.requested_as_of]
      );
      for (const fund of account.funds) {
        await client.query(
          `
          INSERT INTO mpf.snapshot_fund_values (
            account_id, as_of_date, fund_id, units, price_date, price_used, value, price_status, units_status
          )
          VALUES ($1::uuid, $2::date, $3, $4::numeric, $5::date, $6::numeric, $7::numeric, $8, $9)
          `,
          [
            account.account_id,
            calculation.requested_as_of,
            fund.fund_id,
            fund.units,
            fund.price_date,
            fund.price,
            fund.market_value,
            fund.price_status,
            fund.units_status
          ]
        );
      }
      saved += 1;
    }
    return { saved_accounts: saved };
  });
}

export async function applyPendingInvalidations(accountId?: string): Promise<number> {
  return withTransaction(async (client) => {
    const params: unknown[] = [];
    let accountFilter = "";
    if (accountId) {
      accountFilter = "AND account_id = $1::uuid";
      params.push(accountId);
    }
    const rows = await client.query(
      `
      SELECT invalidation_id::text, account_id::text, from_date::text, to_date::text
      FROM mpf.snapshot_invalidation_requests
      WHERE processed_at IS NULL
        ${accountFilter}
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      `,
      params
    );
    if (rows.rows.length === 0) {
      return 0;
    }

    for (const row of rows.rows as Array<{
      invalidation_id: string;
      account_id: string | null;
      from_date: string | null;
      to_date: string | null;
    }>) {
      const where: string[] = ["TRUE"];
      const whereParams: unknown[] = [];
      let i = 1;
      if (row.account_id) {
        where.push(`account_id = $${i++}::uuid`);
        whereParams.push(row.account_id);
      }
      if (row.from_date) {
        where.push(`as_of_date >= $${i++}::date`);
        whereParams.push(row.from_date);
      }
      if (row.to_date) {
        where.push(`as_of_date <= $${i++}::date`);
        whereParams.push(row.to_date);
      }
      await client.query(
        `
        UPDATE mpf.portfolio_snapshots
        SET stale = TRUE, updated_at = NOW()
        WHERE ${where.join(" AND ")}
        `,
        whereParams
      );
    }

    await client.query(
      `
      UPDATE mpf.snapshot_invalidation_requests
      SET processed_at = NOW()
      WHERE invalidation_id = ANY($1::uuid[])
      `,
      [rows.rows.map((row: { invalidation_id: string }) => row.invalidation_id)]
    );
    return rows.rows.length;
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
