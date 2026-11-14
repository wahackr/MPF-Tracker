import { Decimal } from "decimal.js";

import { FundPayload, HoldingRow, valueHolding } from "./libs/rules.js";
import { query } from "./libs/db.js";

type AccountPayload = {
  account_id: string;
  currency: string;
  calculation_status: "COMPLETE" | "PARTIAL" | "STALE";
  total_value: string | null;
  priced_subtotal: string;
  unpriced_fund_count: number;
  funds: FundPayload[];
};

export type CalculationResult = {
  requested_as_of: string;
  calculated_at: string;
  currency: string;
  calculation_status: "COMPLETE" | "PARTIAL" | "STALE";
  total_value: string | null;
  priced_subtotal: string;
  unpriced_fund_count: number;
  accounts: AccountPayload[];
};

export async function calculatePortfolioAsOf(
  asOfDate: string,
  accountId?: string,
  includeEstimated = true,
  staleAfterDays = 3
): Promise<CalculationResult> {
  // Load the latest baselines, transaction deltas and as-of prices in one database read.
  const params: unknown[] = [asOfDate];
  let accountFilter = "";

  if (accountId) {
    accountFilter = "AND hb.account_id = $2::uuid";
    params.push(accountId);
  }

  const holdings = (await query<HoldingRow & {
    price_date: string | null;
    price: string | null;
    price_type: string;
  }>(
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
    ), holdings AS (
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
    )
    SELECT h.*, price.price_date::text, price.bid::text AS price, 'BID'::text AS price_type
    FROM holdings h
    LEFT JOIN LATERAL (
      SELECT price_date, bid FROM mpf.fund_prices
      WHERE fund_id = h.fund_id AND price_date <= $1::date
      ORDER BY price_date DESC LIMIT 1
    ) price ON TRUE
    ORDER BY h.account_id, h.fund_id
    `,
    params
  )).rows;

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

  // Aggregate the batch in memory; no database calls occur inside the fund loop.
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

    const priceInfo = holding.price_date && holding.price !== null
      ? { price_date: holding.price_date, price: holding.price, price_type: holding.price_type }
      : null;
    const fundPayload = valueHolding(holding, priceInfo, asOfDate, includeEstimated, staleAfterDays);

    if (fundPayload.market_value !== null) {
      accountEntry.priced_subtotal = accountEntry.priced_subtotal.plus(fundPayload.market_value);
      accountEntry.total_value = accountEntry.total_value.plus(fundPayload.market_value);
      accountEntry.any_stale = accountEntry.any_stale || fundPayload.is_stale;
    } else {
      accountEntry.unpriced_fund_count += 1;
    }
    accountEntry.funds.push(fundPayload);
  }

  let aggregateSubtotal = new Decimal(0);
  let totalUnpriced = 0;
  let anyStale = false;
  const accounts: AccountPayload[] = [];

  // Determine each account status before calculating the portfolio-wide status.
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
