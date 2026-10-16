import { expect, test } from "@jest/globals";
import {
  AllocationRuleSchema, BaselineSchema, ContributionPlanSchema,
  CreateAccountSchema, ReconciliationSchema, UpdateAccountSchema
} from "../../../dist/libs/portfolio.js";

// testing data
const account = { provider: "hsbc", scheme: "MPF", display_label: "Employee account" };
const holding = { fund_id: "HSBC:FUND_A", units: "12.3456789012" };
const baseline = {
  effective_date: "2026-10-01", source: "statement", verification_status: "VERIFIED", holdings: [holding]
};
const rule = {
  effective_from: "2026-10-01", contribution_stream: "employee",
  allocations: [{ fund_id: "HSBC:FUND_A", weight: "100" }]
};
const plan = {
  contribution_stream: "employee", amount: "1000.00", expected_day: 31, effective_from: "2026-10-01"
};
const schemaCases = [
  [CreateAccountSchema, account, true],
  [CreateAccountSchema, { ...account, provider: "" }, false],
  [CreateAccountSchema, { ...account, currency: "HK" }, false],
  [UpdateAccountSchema, { active: false }, true],
  [UpdateAccountSchema, { active: "false" }, false],
  [BaselineSchema, baseline, true],
  [BaselineSchema, { ...baseline, effective_date: "01/10/2026" }, false],
  [BaselineSchema, { ...baseline, holdings: [] }, false],
  [BaselineSchema, { ...baseline, verification_status: "APPROVED" }, false],
  [ReconciliationSchema, { effective_date: "2026-10-14", holdings: [holding] }, true],
  [ReconciliationSchema, { effective_date: "2026-10-14", holdings: [] }, false],
  [AllocationRuleSchema, rule, true],
  [AllocationRuleSchema, { ...rule, allocations: [] }, false],
  [AllocationRuleSchema, { ...rule, effective_from: "October 1" }, false],
  [ContributionPlanSchema, plan, true],
  [ContributionPlanSchema, { ...plan, expected_day: 0 }, false],
  [ContributionPlanSchema, { ...plan, expected_day: 32 }, false],
  [ContributionPlanSchema, { ...plan, amount: undefined }, false]
];

test.each(schemaCases)("validates portfolio payload %#", (schema, payload, valid) => {
  // test
  const result = schema.safeParse(payload);

  // assert
  expect(result.success).toBe(valid);
});

test("accounts default to HKD", () => {
  // test
  const result = CreateAccountSchema.parse(account);

  // assert
  expect(result).toEqual({ ...account, currency: "HKD" });
});
