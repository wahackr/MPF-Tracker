import { Decimal } from "decimal.js";
import { PoolClient } from "pg";

import { query } from "./db.js";

export async function loadActivePlans(client: PoolClient, asOfDate: string, accountId: string | undefined) {
  const params: unknown[] = [asOfDate];
  let accountFilter = "";
  if (accountId) {
    accountFilter = "AND account_id = $2::uuid";
    params.push(accountId);
  }
  const rows = await client.query(
    `
    SELECT plan_id, account_id, contribution_stream, amount, expected_day
    FROM mpf.contribution_plans
    WHERE active = TRUE
      AND effective_from <= $1::date
      AND (effective_to IS NULL OR effective_to >= $1::date)
      ${accountFilter}
    ORDER BY plan_id
    `,
    params
  );
  return rows.rows;
}

export async function upsertContributionEvent(
  client: PoolClient,
  planId: string,
  period: string,
  expectedDate: string,
  amount: string
) {
  const row = await client.query(
    `
    INSERT INTO mpf.contribution_events (
      plan_id, period, expected_date, amount, status
    )
    VALUES ($1::uuid, $2::date, $3::date, $4::numeric, 'EXPECTED')
    ON CONFLICT (plan_id, period)
    DO NOTHING
    RETURNING event_id, status
    `,
    [planId, period, expectedDate, amount]
  );
  if (row.rows.length > 0) return row.rows[0] as { event_id: string; status: string };
  const existing = await client.query(
    "SELECT event_id, status FROM mpf.contribution_events WHERE plan_id = $1::uuid AND period = $2::date",
    [planId, period]
  );
  return existing.rows[0] as { event_id: string; status: string };
}

export async function loadAllocations(
  client: PoolClient,
  accountId: string,
  contributionStream: string,
  period: string
) {
  const rows = await client.query(
    `
    WITH selected_version AS (
      SELECT MAX(effective_from) AS effective_from
      FROM mpf.allocation_rules
      WHERE account_id = $1::uuid
        AND contribution_stream = $2
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
    )
    SELECT ar.fund_id, ar.weight
    FROM mpf.allocation_rules ar
    JOIN selected_version sv ON ar.effective_from = sv.effective_from
    WHERE ar.account_id = $1::uuid
      AND ar.contribution_stream = $2
    ORDER BY ar.fund_id
    `,
    [accountId, contributionStream, period]
  );
  return rows.rows as { fund_id: string; weight: string }[];
}

export async function findPriceForEstimation(
  client: PoolClient,
  fundId: string,
  expectedDate: string,
  maxDelayDays: number,
  asOfDate: string
): Promise<{ price_date: string; price: string } | null> {
  const rows = await client.query(
    `
    SELECT fp.price_date,
           CASE
             WHEN f.provider = 'hsbc' THEN fp.bid
             WHEN f.provider = 'manulife' THEN fp.price
             ELSE COALESCE(fp.price, fp.bid, fp.offer)
           END AS price
    FROM mpf.fund_prices fp
    JOIN mpf.funds f ON f.fund_id = fp.fund_id
    WHERE fp.fund_id = $1
      AND fp.price_date >= $2::date
      AND fp.price_date <= ($2::date + ($3::int * INTERVAL '1 day'))::date
      AND fp.price_date <= $4::date
    ORDER BY fp.price_date ASC
    LIMIT 1
    `,
    [fundId, expectedDate, maxDelayDays, asOfDate]
  );
  if (rows.rows.length === 0 || rows.rows[0].price === null || new Decimal(rows.rows[0].price).lte(0)) {
    return null;
  }
  return rows.rows[0] as { price_date: string; price: string };
}

export async function setEventStatus(client: PoolClient, eventId: string, status: string): Promise<void> {
  await client.query(
    `
    UPDATE mpf.contribution_events
    SET status = $2, updated_at = NOW()
    WHERE event_id = $1::uuid
    `,
    [eventId, status]
  );
}

export async function upsertEstimatedTransaction(
  client: PoolClient,
  eventId: string,
  fundId: string,
  tradeDate: string,
  cashAmount: Decimal,
  unitPrice: Decimal,
  unitsDelta: Decimal
): Promise<{ inserted: boolean; changed: boolean }> {
  const row = await client.query(
    `
    INSERT INTO mpf.purchase_transactions (
      event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy
    )
    VALUES ($1::uuid, $2, $3::date, $4::numeric, $5::numeric, $6::numeric, 'ESTIMATED', 'first_price_on_or_after')
    ON CONFLICT (event_id, fund_id)
    DO UPDATE SET
      trade_date = EXCLUDED.trade_date,
      cash_amount = EXCLUDED.cash_amount,
      unit_price = EXCLUDED.unit_price,
      units_delta = EXCLUDED.units_delta,
      status = CASE
          WHEN mpf.purchase_transactions.status = 'CONFIRMED' THEN mpf.purchase_transactions.status
          ELSE 'ESTIMATED'
      END,
      estimation_policy = CASE
          WHEN mpf.purchase_transactions.status = 'CONFIRMED' THEN mpf.purchase_transactions.estimation_policy
          ELSE 'first_price_on_or_after'
      END,
      updated_at = NOW()
    WHERE mpf.purchase_transactions.status <> 'CONFIRMED'
      AND (
        mpf.purchase_transactions.trade_date IS DISTINCT FROM EXCLUDED.trade_date
        OR mpf.purchase_transactions.cash_amount IS DISTINCT FROM EXCLUDED.cash_amount
        OR mpf.purchase_transactions.unit_price IS DISTINCT FROM EXCLUDED.unit_price
        OR mpf.purchase_transactions.units_delta IS DISTINCT FROM EXCLUDED.units_delta
      )
    RETURNING (xmax = 0) AS inserted
    `,
    [eventId, fundId, tradeDate, cashAmount.toFixed(8), unitPrice.toFixed(10), unitsDelta.toFixed(10)]
  );
  if (row.rows.length === 0) {
    return { inserted: false, changed: false };
  }
  return { inserted: Boolean(row.rows[0].inserted), changed: true };
}

export async function listPurchaseEvents(limit: number): Promise<unknown[]> {
  const rows = await query(
    `
    SELECT event_id, plan_id, period, expected_date, amount, status, created_at, updated_at
    FROM mpf.contribution_events
    ORDER BY expected_date DESC, created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return rows.rows;
}

export async function listPurchaseTransactions(limit: number): Promise<unknown[]> {
  const rows = await query(
    `
    SELECT transaction_id, event_id, fund_id, trade_date, cash_amount, unit_price,
           units_delta, status, estimation_policy, created_at, updated_at
    FROM mpf.purchase_transactions
    ORDER BY trade_date DESC, updated_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return rows.rows;
}
