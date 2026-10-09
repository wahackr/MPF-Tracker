import { Decimal } from "decimal.js";
import { PoolClient } from "pg";

import { query, withTransaction } from "./db.js";

type HoldingRow = {
  account_id: string;
  fund_id: string;
  effective_date: string;
  units: string;
  verification_status: string;
  confirmed_delta: string;
  estimated_delta: string;
};

type FundPayload = {
  fund_id: string;
  units: string;
  baseline_date: string;
  baseline_verification_status: string;
  units_status: "ESTIMATED" | "VERIFIED";
  price_date: string | null;
  price: string | null;
  price_type: string | null;
  days_stale: number | null;
  is_stale: boolean;
  market_value: string | null;
  price_status: "MISSING" | "FRESH" | "STALE";
};

type AccountPayload = {
  account_id: string;
  currency: string;
  calculation_status: "COMPLETE" | "PARTIAL" | "STALE";
  total_value: string | null;
  priced_subtotal: string;
  unpriced_fund_count: number;
  funds: FundPayload[];
};

type CalculationResult = {
  requested_as_of: string;
  calculated_at: string;
  currency: string;
  calculation_status: "COMPLETE" | "PARTIAL" | "STALE";
  total_value: string | null;
  priced_subtotal: string;
  unpriced_fund_count: number;
  accounts: AccountPayload[];
};

function isoDate(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

async function loadHoldings(asOfDate: string, accountId?: string): Promise<HoldingRow[]> {
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

async function loadLatestPrice(fundId: string, asOfDate: string): Promise<{
  price_date: string;
  price: string;
  price_type: string;
} | null> {
  const row = await query<{ price_date: string; price: string | null; price_type: string }>(
    `
    SELECT
      fp.price_date::text,
      CASE
        WHEN f.provider = 'hsbc' THEN fp.bid
        WHEN f.provider = 'manulife' THEN fp.nav
        ELSE COALESCE(fp.nav, fp.bid, fp.offer)
      END::text AS price,
      CASE
        WHEN f.provider = 'hsbc' THEN 'BID'
        WHEN f.provider = 'manulife' THEN 'NAV'
        WHEN fp.nav IS NOT NULL THEN 'NAV'
        WHEN fp.bid IS NOT NULL THEN 'BID'
        WHEN fp.offer IS NOT NULL THEN 'OFFER'
        ELSE 'UNKNOWN'
      END AS price_type
    FROM mpf.fund_prices fp
    JOIN mpf.funds f ON f.fund_id = fp.fund_id
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

export async function calculatePortfolioAsOf(
  asOfDate: string,
  accountId?: string,
  includeEstimated = true,
  staleAfterDays = 3
): Promise<CalculationResult> {
  const holdings = await loadHoldings(asOfDate, accountId);
  const accountMap = new Map<
    string,
    {
      account_id: string;
      currency: string;
      funds: FundPayload[];
      priced_subtotal: Decimal;
      total_value: Decimal;
      unpriced_fund_count: number;
      any_stale: boolean;
    }
  >();

  for (const holding of holdings) {
    const accountEntry = accountMap.get(holding.account_id) ?? {
      account_id: holding.account_id,
      currency: "HKD",
      funds: [],
      priced_subtotal: new Decimal(0),
      total_value: new Decimal(0),
      unpriced_fund_count: 0,
      any_stale: false
    };
    accountMap.set(holding.account_id, accountEntry);

    let units = new Decimal(holding.units).plus(new Decimal(holding.confirmed_delta));
    let estimatedComponent = false;
    if (includeEstimated) {
      const estimatedDelta = new Decimal(holding.estimated_delta);
      units = units.plus(estimatedDelta);
      estimatedComponent = !estimatedDelta.eq(0);
    }
    if (holding.verification_status !== "VERIFIED") {
      estimatedComponent = true;
    }

    const priceInfo = await loadLatestPrice(holding.fund_id, asOfDate);
    const fundPayload: FundPayload = {
      fund_id: holding.fund_id,
      units: units.toFixed(10),
      baseline_date: holding.effective_date,
      baseline_verification_status: holding.verification_status,
      units_status: estimatedComponent ? "ESTIMATED" : "VERIFIED",
      price_date: null,
      price: null,
      price_type: null,
      days_stale: null,
      is_stale: false,
      market_value: null,
      price_status: "MISSING"
    };

    if (priceInfo) {
      const priceDate = isoDate(priceInfo.price_date);
      const daysStale = Math.floor(
        (new Date(`${asOfDate}T00:00:00Z`).getTime() - new Date(`${priceDate}T00:00:00Z`).getTime()) /
          (24 * 60 * 60 * 1000)
      );
      const isStale = daysStale > staleAfterDays;
      const marketValue = units.mul(new Decimal(priceInfo.price));
      fundPayload.price_date = priceDate;
      fundPayload.price = new Decimal(priceInfo.price).toFixed(10);
      fundPayload.price_type = priceInfo.price_type;
      fundPayload.days_stale = daysStale;
      fundPayload.is_stale = isStale;
      fundPayload.market_value = marketValue.toFixed(8);
      fundPayload.price_status = isStale ? "STALE" : "FRESH";

      accountEntry.priced_subtotal = accountEntry.priced_subtotal.plus(marketValue);
      accountEntry.total_value = accountEntry.total_value.plus(marketValue);
      accountEntry.any_stale = accountEntry.any_stale || isStale;
    } else {
      accountEntry.unpriced_fund_count += 1;
    }
    accountEntry.funds.push(fundPayload);
  }

  let aggregateSubtotal = new Decimal(0);
  let totalUnpriced = 0;
  let anyStale = false;
  const accounts: AccountPayload[] = [];
  for (const account of accountMap.values()) {
    aggregateSubtotal = aggregateSubtotal.plus(account.priced_subtotal);
    totalUnpriced += account.unpriced_fund_count;
    anyStale = anyStale || account.any_stale;
    let status: "COMPLETE" | "PARTIAL" | "STALE";
    let totalValue: string | null;
    if (account.unpriced_fund_count > 0) {
      status = "PARTIAL";
      totalValue = null;
    } else if (account.any_stale) {
      status = "STALE";
      totalValue = account.total_value.toFixed(8);
    } else {
      status = "COMPLETE";
      totalValue = account.total_value.toFixed(8);
    }
    accounts.push({
      account_id: account.account_id,
      currency: account.currency,
      calculation_status: status,
      total_value: totalValue,
      priced_subtotal: account.priced_subtotal.toFixed(8),
      unpriced_fund_count: account.unpriced_fund_count,
      funds: account.funds
    });
  }

  let status: "COMPLETE" | "PARTIAL" | "STALE";
  let totalValue: string | null;
  if (totalUnpriced > 0) {
    status = "PARTIAL";
    totalValue = null;
  } else if (anyStale) {
    status = "STALE";
    totalValue = aggregateSubtotal.toFixed(8);
  } else {
    status = "COMPLETE";
    totalValue = aggregateSubtotal.toFixed(8);
  }

  return {
    requested_as_of: asOfDate,
    calculated_at: new Date().toISOString(),
    currency: "HKD",
    calculation_status: status,
    total_value: totalValue,
    priced_subtotal: aggregateSubtotal.toFixed(8),
    unpriced_fund_count: totalUnpriced,
    accounts: accounts.sort((a, b) => a.account_id.localeCompare(b.account_id))
  };
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
