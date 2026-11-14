import { expect, test } from "@jest/globals";
import { hkToday, valueHolding } from "../../../dist/libs/rules.js";

// testing data
const holding = {
  account_id: "account-1", fund_id: "fund-1", effective_date: "2026-10-01",
  units: "100.0000000000", verification_status: "VERIFIED", confirmed_delta: "2.5", estimated_delta: "1.25"
};

test("valuation applies transaction deltas with decimal precision", () => {
  // testing data
  const price = { price_date: "2026-10-09", price: "1.2345678901", price_type: "BID" };

  // test
  const fund = valueHolding(holding, price, "2026-10-09", true, 3);

  // assert
  expect(fund.units).toBe("103.7500000000");
  expect(fund.units_status).toBe("ESTIMATED");
  expect(fund.market_value).toBe("128.08641860");
});

test("future prices cannot enter an earlier as-of valuation", () => {
  // testing data
  const price = { price_date: "2026-10-10", price: "2", price_type: "BID" };

  // test
  const fund = valueHolding(holding, price, "2026-10-09", false, 3);

  // assert
  expect(fund.price_status).toBe("MISSING");
  expect(fund.market_value).toBeNull();
  expect(fund.units).toBe("102.5000000000");
});

test.each([null, "0", "-1"])("unusable price %s produces an unpriced fund", (price) => {
  // testing data
  const priceInfo = price === null ? null : { price_date: "2026-10-09", price, price_type: "BID" };

  // test
  const fund = valueHolding(holding, priceInfo, "2026-10-09", true, 3);

  // assert
  expect(fund.price_status).toBe("MISSING");
  expect(fund.market_value).toBeNull();
});

test("old prices are marked stale", () => {
  // testing data
  const price = { price_date: new Date("2026-10-01T00:00:00Z"), price: "1", price_type: "BID" };

  // test
  const fund = valueHolding(holding, price, "2026-10-09", false, 3);

  // assert
  expect(fund.price_status).toBe("STALE");
  expect(fund.days_stale).toBe(8);
});

test("today uses Hong Kong midnight", () => {
  // testing data
  const beforeMidnight = new Date("2026-10-09T15:59:59Z");
  const midnight = new Date("2026-10-09T16:00:00Z");

  // test
  const before = hkToday(beforeMidnight);
  const after = hkToday(midnight);

  // assert
  expect(before).toBe("2026-10-09");
  expect(after).toBe("2026-10-10");
});
