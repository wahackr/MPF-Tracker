import assert from "node:assert/strict";
import test from "node:test";

import { allocationWeightError, decimalString } from "../../../dist/libs/rules.js";

test("allocation weights use decimal arithmetic", () => {
  assert.equal(allocationWeightError([{ weight: "33.3" }, { weight: "66.7" }]), null);
  assert.equal(allocationWeightError([{ weight: "99.99" }]), "total");
  assert.equal(allocationWeightError([{ weight: "110" }, { weight: "-10" }]), "negative");
  assert.equal(decimalString("0.1000000001"), "0.1000000001");
});
