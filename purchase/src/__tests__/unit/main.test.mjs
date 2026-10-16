import assert from "node:assert/strict";
import test from "node:test";

import { confirmPurchaseEvent, processPurchases } from "../../../dist/main.js";

test("estimating a purchase invalidates snapshots after the contribution date", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM mpf.contribution_plans")) {
        return { rows: [{ plan_id: "plan-1", account_id: "account-1", contribution_stream: "employee", amount: "100", expected_day: 10 }] };
      }
      if (sql.includes("INSERT INTO mpf.contribution_events")) {
        return { rows: [{ event_id: "event-1", status: "EXPECTED" }] };
      }
      if (sql.includes("FROM mpf.allocation_rules")) {
        return { rows: [{ fund_id: "fund-1", weight: "100" }] };
      }
      if (sql.includes("FROM mpf.fund_prices")) {
        return { rows: [{ price_date: "2026-10-12", price: "1" }] };
      }
      if (sql.includes("INSERT INTO mpf.purchase_transactions")) {
        return { rows: [{ inserted: true }] };
      }
      if (sql.includes("UPDATE mpf.contribution_events") || sql.includes("INSERT INTO mpf.snapshot_invalidation_requests")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await processPurchases({
    as_of_date: "2026-10-15",
    account_id: "account-1"
  }, async (work) => work(client));

  assert.equal(result.inserted_transactions, 1);
  const invalidation = calls.find(({ sql }) => sql.includes("INSERT INTO mpf.snapshot_invalidation_requests"));
  assert.ok(invalidation);
  assert.deepEqual(invalidation.params, ["account-1", "2026-10-10"]);
  assert.match(invalidation.sql, /purchase_estimation/);
  assert.doesNotMatch(invalidation.sql, /to_date/);
});

test("unscoped processing invalidates only changed accounts from each earliest expected date", async () => {
  const calls = [];
  const plans = [
    { plan_id: "plan-a-late", account_id: "account-a", contribution_stream: "employee", amount: "100", expected_day: 10 },
    { plan_id: "plan-b", account_id: "account-b", contribution_stream: "employee", amount: "100", expected_day: 12 },
    { plan_id: "plan-a-early", account_id: "account-a", contribution_stream: "employer", amount: "100", expected_day: 5 },
    { plan_id: "plan-unchanged", account_id: "account-c", contribution_stream: "employee", amount: "100", expected_day: 2 },
    { plan_id: "plan-confirmed", account_id: "account-d", contribution_stream: "employee", amount: "100", expected_day: 1 }
  ];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM mpf.contribution_plans")) return { rows: plans };
      if (sql.includes("INSERT INTO mpf.contribution_events")) {
        return { rows: [{ event_id: params[0], status: params[0] === "plan-confirmed" ? "CONFIRMED" : "EXPECTED" }] };
      }
      if (sql.includes("FROM mpf.allocation_rules")) {
        return { rows: [{ fund_id: `${params[0]}-${params[1]}`, weight: "100" }] };
      }
      if (sql.includes("FROM mpf.fund_prices")) {
        return { rows: [{ price_date: "2026-10-15", price: "1" }] };
      }
      if (sql.includes("INSERT INTO mpf.purchase_transactions")) {
        return { rows: params[0] === "plan-unchanged" ? [] : [{ inserted: true }] };
      }
      if (sql.includes("UPDATE mpf.contribution_events") || sql.includes("INSERT INTO mpf.snapshot_invalidation_requests")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const result = await processPurchases({ as_of_date: "2026-10-15" }, async (work) => work(client));

  assert.equal(result.inserted_transactions, 3);
  const invalidations = calls.filter(({ sql }) => sql.includes("INSERT INTO mpf.snapshot_invalidation_requests"));
  assert.deepEqual(invalidations.map(({ params }) => params), [
    ["account-a", "2026-10-05"],
    ["account-b", "2026-10-12"]
  ]);
  for (const { sql } of invalidations) {
    assert.match(sql, /purchase_estimation/);
    assert.doesNotMatch(sql, /to_date/);
  }
});

for (const [oldDate, newDate, expectedStart] of [
  [null, "2026-10-12", "2026-10-12"],
  ["2026-10-08", "2026-10-12", "2026-10-08"],
  ["2026-10-12", "2026-10-08", "2026-10-08"]
]) {
  test(`confirmation moving a trade from ${oldDate} to ${newDate} invalidates from ${expectedStart}`, async () => {
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes("FROM mpf.contribution_events e")) {
          return { rows: [{ event_id: "event-1", account_id: "account-1" }] };
        }
        if (sql.includes("MIN(trade_date)")) {
          return { rows: [{ earliest_date: oldDate }] };
        }
        if (sql.includes("DELETE FROM mpf.purchase_transactions")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO mpf.purchase_transactions") ||
            sql.includes("UPDATE mpf.contribution_events") ||
            sql.includes("INSERT INTO mpf.snapshot_invalidation_requests")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }
    };

    const result = await confirmPurchaseEvent("event-1", {
      trade_date: newDate,
      transactions: [{ fund_id: "fund-1", cash_amount: "100", unit_price: "1", units_delta: "100" }]
    }, async (work) => work(client));

    assert.equal(result.confirmed_transactions, 1);
    const invalidation = calls.find(({ sql }) => sql.includes("INSERT INTO mpf.snapshot_invalidation_requests"));
    assert.ok(invalidation);
    assert.deepEqual(invalidation.params, ["account-1", expectedStart]);
    assert.match(invalidation.sql, /purchase_confirmation/);
    assert.doesNotMatch(invalidation.sql, /to_date/);
  });
}
