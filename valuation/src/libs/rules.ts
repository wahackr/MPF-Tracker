import { Decimal } from "decimal.js";

export type HoldingRow = {
  account_id: string;
  fund_id: string;
  effective_date: string;
  units: string;
  verification_status: string;
  confirmed_delta: string;
  estimated_delta: string;
};

export type PriceInfo = { price_date: Date | string; price: string; price_type: string };

export type FundPayload = {
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

export function hkToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

export function valueHolding(
  holding: HoldingRow,
  priceInfo: PriceInfo | null,
  asOfDate: string,
  includeEstimated: boolean,
  staleAfterDays: number
): FundPayload {
  const estimatedDelta = includeEstimated ? new Decimal(holding.estimated_delta) : new Decimal(0);
  const units = new Decimal(holding.units)
    .plus(new Decimal(holding.confirmed_delta))
    .plus(estimatedDelta);
  const fund: FundPayload = {
    fund_id: holding.fund_id,
    units: units.toFixed(10),
    baseline_date: holding.effective_date,
    baseline_verification_status: holding.verification_status,
    units_status: holding.verification_status !== "VERIFIED" || !estimatedDelta.eq(0) ? "ESTIMATED" : "VERIFIED",
    price_date: null,
    price: null,
    price_type: null,
    days_stale: null,
    is_stale: false,
    market_value: null,
    price_status: "MISSING"
  };
  if (!priceInfo) return fund;

  const priceDate = isoDate(priceInfo.price_date);
  if (priceDate > asOfDate) return fund;
  const daysStale = Math.floor(
    (Date.parse(`${asOfDate}T00:00:00Z`) - Date.parse(`${priceDate}T00:00:00Z`)) / 86_400_000
  );
  const price = new Decimal(priceInfo.price);
  if (!price.gt(0)) return fund;
  const stale = daysStale > staleAfterDays;
  fund.price_date = priceDate;
  fund.price = price.toFixed(10);
  fund.price_type = priceInfo.price_type;
  fund.days_stale = daysStale;
  fund.is_stale = stale;
  fund.market_value = units.mul(price).toFixed(8);
  fund.price_status = stale ? "STALE" : "FRESH";
  return fund;
}
