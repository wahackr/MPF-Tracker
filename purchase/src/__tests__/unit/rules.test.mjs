import { expect, test } from "@jest/globals";
import { expectedDateForMonth, hkToday, monthStart, purchaseUnits, weightsTotalOneHundred } from "../../../dist/libs/rules.js";

// testing data
const monthEnds = [
  ["2028-02-01", "2028-02-29"],
  ["2027-02-01", "2027-02-28"],
  ["2026-04-01", "2026-04-30"]
];

test.each(monthEnds)("caps contribution day at month end for %s", (period, expected) => {
  // test
  const result = expectedDateForMonth(period, 31);

  // assert
  expect(result).toBe(expected);
});

test("monthStart preserves the year and month", () => {
  // testing data
  const date = "2026-12-31";

  // test
  const result = monthStart(date);

  // assert
  expect(result).toBe("2026-12-01");
});

test("money and units use decimal arithmetic", () => {
  // testing data
  const weightedPurchase = { amount: "100.00", weight: "3", price: "3" };
  const fractionalPurchase = { amount: "0.3", weight: "100", price: "0.1" };

  // test
  const weightedUnits = purchaseUnits(weightedPurchase.amount, weightedPurchase.weight, weightedPurchase.price);
  const fractionalUnits = purchaseUnits(fractionalPurchase.amount, fractionalPurchase.weight, fractionalPurchase.price);

  // assert
  expect(weightedUnits.toFixed(10)).toBe("1.0000000000");
  expect(fractionalUnits.toFixed(10)).toBe("3.0000000000");
});

test.each(["0", "-1"])("rejects nonpositive unit price %s", (price) => {
  // test
  const operation = () => purchaseUnits("100", "100", price);

  // assert
  expect(operation).toThrow(/price must be positive/);
});

test("allocation weights must be nonnegative and total exactly 100", () => {
  // testing data
  const valid = [{ weight: "33.3" }, { weight: "66.7" }];
  const incomplete = [{ weight: "99.9" }];
  const negative = [{ weight: "-1" }, { weight: "101" }];

  // test
  const validTotal = weightsTotalOneHundred(valid);
  const incompleteTotal = weightsTotalOneHundred(incomplete);
  const negativeTotal = weightsTotalOneHundred(negative);
  const emptyTotal = weightsTotalOneHundred([]);

  // assert
  expect(validTotal).toBe(true);
  expect(incompleteTotal).toBe(false);
  expect(negativeTotal).toBe(false);
  expect(emptyTotal).toBe(false);
});

test("today changes at Hong Kong midnight", () => {
  // testing data
  const beforeMidnight = new Date("2026-10-09T15:59:59Z");
  const atMidnight = new Date("2026-10-09T16:00:00Z");

  // test
  const beforeDate = hkToday(beforeMidnight);
  const afterDate = hkToday(atMidnight);

  // assert
  expect(beforeDate).toBe("2026-10-09");
  expect(afterDate).toBe("2026-10-10");
});
