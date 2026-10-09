import assert from "node:assert/strict";
import test from "node:test";

import { hkToday, valueHolding } from "../../../dist/libs/rules.js";

const holding = {
  account_id: "account-1", fund_id: "fund-1", effective_date: "2026-10-01",
  units: "100.0000000000", verification_status: "VERIFIED",
  confirmed_delta: "2.5", estimated_delta: "1.25"
};

test("valuation applies transaction deltas with decimal precision", () => {
  const fund = valueHolding(holding, {
    price_date: "2026-10-09", price: "1.2345678901", price_type: "BID"
  }, "2026-10-09", true, 3);
  assert.equal(fund.units, "103.7500000000");
  assert.equal(fund.units_status, "ESTIMATED");
  assert.equal(fund.market_value, "128.08641860");
});

test("future prices cannot enter an earlier as-of valuation", () => {
  const fund = valueHolding(holding, {
    price_date: "2026-10-10", price: "2", price_type: "BID"
  }, "2026-10-09", false, 3);
  assert.equal(fund.price_status, "MISSING");
  assert.equal(fund.market_value, null);
  assert.equal(fund.units, "102.5000000000");
});

test("stale price and Hong Kong date are explicit", () => {
  const fund = valueHolding(holding, {
    price_date: "2026-10-01", price: "1", price_type: "BID"
  }, "2026-10-09", false, 3);
  assert.equal(fund.price_status, "STALE");
  assert.equal(fund.days_stale, 8);
  assert.equal(hkToday(new Date("2026-10-09T17:00:00Z")), "2026-10-10");
});
