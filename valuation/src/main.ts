import { Decimal } from "decimal.js";

import { FundPayload, valueHolding } from "./libs/rules.js";
import { loadHoldings, loadLatestPrice } from "./libs/repository.js";

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

    const priceInfo = await loadLatestPrice(holding.fund_id, asOfDate);
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
