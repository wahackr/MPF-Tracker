import { Decimal } from "decimal.js";

export function decimalString(value: string | number): string {
  return new Decimal(value).toFixed();
}

export function allocationWeightError(
  allocations: Array<{ weight: string | number }>
): "negative" | "total" | null {
  let total = new Decimal(0);
  for (const allocation of allocations) {
    const weight = new Decimal(allocation.weight);
    if (weight.lt(0)) return "negative";
    total = total.plus(weight);
  }
  return total.eq(100) ? null : "total";
}
