import { Decimal } from "decimal.js";

export function hkToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

export function expectedDateForMonth(period: string, expectedDay: number): string {
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period.slice(0, 8)}${String(Math.min(expectedDay, lastDay)).padStart(2, "0")}`;
}

export function weightsTotalOneHundred(allocations: Array<{ weight: string | number }>): boolean {
  const weights = allocations.map((item) => new Decimal(item.weight));
  return weights.every((weight) => weight.gte(0)) &&
    weights.reduce((sum, weight) => sum.plus(weight), new Decimal(0)).eq(100);
}

export function purchaseUnits(
  amount: Decimal.Value,
  weight: Decimal.Value,
  price: Decimal.Value
): Decimal {
  const unitPrice = new Decimal(price);
  if (!unitPrice.gt(0)) throw new Error("price must be positive");
  return new Decimal(amount).mul(new Decimal(weight)).div(100).div(unitPrice);
}
