import assert from "node:assert/strict";
import test from "node:test";

import { expectedDateForMonth, hkToday, purchaseUnits, weightsTotalOneHundred } from "../../../dist/libs/rules.js";

test("expected contribution day is capped at the end of a short month", () => {
  assert.equal(expectedDateForMonth("2028-02-01", 31), "2028-02-29");
  assert.equal(expectedDateForMonth("2027-02-01", 31), "2027-02-28");
});

test("money and units use decimal arithmetic", () => {
  assert.equal(purchaseUnits("100.00", "3", "3").toFixed(10), "1.0000000000");
  assert.equal(weightsTotalOneHundred([{ weight: "33.3" }, { weight: "66.7" }]), true);
  assert.equal(weightsTotalOneHundred([{ weight: "99.9" }]), false);
  assert.throws(() => purchaseUnits("100", "100", "0"), /price must be positive/);
});

test("today uses the Hong Kong business date", () => {
  assert.equal(hkToday(new Date("2026-10-09T17:00:00Z")), "2026-10-10");
});
