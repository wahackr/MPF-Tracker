import { expect, test } from "@jest/globals";
import { allocationWeightError, decimalString } from "../../../dist/libs/rules.js";

// testing data
const allocations = [
  [[{ weight: "33.3" }, { weight: "66.7" }], null],
  [[{ weight: "0" }, { weight: "100" }], null],
  [[{ weight: "99.99" }], "total"],
  [[{ weight: "110" }, { weight: "-10" }], "negative"]
];

test.each(allocations)("validates exact allocation totals: %j", (funds, expected) => {
  // test
  const result = allocationWeightError(funds);

  // assert
  expect(result).toBe(expected);
});

test("holding units retain decimal precision", () => {
  // testing data
  const units = "0.1000000001";

  // test
  const result = decimalString(units);

  // assert
  expect(result).toBe(units);
});
