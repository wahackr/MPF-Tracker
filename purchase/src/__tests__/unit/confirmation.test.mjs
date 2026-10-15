import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

import { confirmPurchaseEvent } from "../../../dist/main.js";

// Exercise the public operation, including its transaction boundary, with a
// stateful database double. Reject unexpected SQL rather than silently passing.
function database(t, initialTransactions, { missingEvent = false } = {}) {
  const state = {
    transactions: structuredClone(initialTransactions),
    status: "ESTIMATED",
    invalidations: [],
    committed: false,
    rolledBack: false,
    released: false
  };
  const initial = structuredClone(state);
  const client = {
    async query(sql, params = []) {
      const statement = sql.trim();
      if (statement === "BEGIN") return { rows: [] };
      if (statement === "COMMIT") {
        state.committed = true;
        return { rows: [] };
      }
      if (statement === "ROLLBACK") {
        Object.assign(state, initial, { rolledBack: true });
        return { rows: [] };
      }
      if (statement.startsWith("SELECT e.event_id")) {
        assert.match(statement, /FOR UPDATE OF e/);
        assert.deepEqual(params, ["event-1"]);
        return { rows: missingEvent ? [] : [{ event_id: "event-1", account_id: "account-1" }] };
      }
      if (statement.startsWith("SELECT trade_date::text")) {
        assert.deepEqual(params, ["event-1"]);
        return { rows: state.transactions.map(({ trade_date }) => ({ trade_date })) };
      }
      if (statement.startsWith("DELETE FROM mpf.purchase_transactions")) {
        assert.match(statement, /WHERE event_id = \$1::uuid AND NOT \(fund_id = ANY\(\$2::text\[\]\)\)/);
        assert.equal(params[0], "event-1");
        state.transactions = state.transactions.filter((tx) => params[1].includes(tx.fund_id));
        return { rows: [] };
      }
      if (statement.startsWith("INSERT INTO mpf.purchase_transactions")) {
        assert.match(statement, /ON CONFLICT \(event_id, fund_id\)/);
        assert.match(statement, /status = 'CONFIRMED'/);
        assert.match(statement, /RETURNING trade_date::text AS trade_date/);
        const [event_id, fund_id, trade_date, cash_amount, unit_price, units_delta] = params;
        const tx = { event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status: "CONFIRMED" };
        const index = state.transactions.findIndex((old) => old.fund_id === fund_id);
        if (index < 0) state.transactions.push(tx);
        else state.transactions[index] = tx;
        return { rows: [{ trade_date }] };
      }
      if (statement.startsWith("UPDATE mpf.contribution_events")) {
        assert.deepEqual(params, ["event-1", "CONFIRMED"]);
        state.status = params[1];
        return { rows: [] };
      }
      if (statement.startsWith("INSERT INTO mpf.snapshot_invalidation_requests")) {
        assert.match(statement, /VALUES \('purchase', 'purchase_confirmation', \$1::uuid, \$2::date, NULL\)/);
        state.invalidations.push({ account_id: params[0], from_date: params[1], to_date: null });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
    release() { state.released = true; }
  };
  t.mock.method(Pool.prototype, "connect", async () => client);
  return state;
}

function transaction(fund_id, trade_date, status = "ESTIMATED") {
  return { fund_id, trade_date, status, cash_amount: "500", unit_price: "10", units_delta: "50" };
}

function assertConfirmed(state, funds, from_date) {
  assert.deepEqual(state.transactions.map((tx) => tx.fund_id).sort(), [...funds].sort());
  assert.ok(state.transactions.every((tx) => tx.status === "CONFIRMED"));
  assert.equal(state.status, "CONFIRMED");
  assert.deepEqual(state.invalidations, [{ account_id: "account-1", from_date, to_date: null }]);
  assert.equal(state.committed, true);
  assert.equal(state.released, true);
}

test("confirming a subset removes omitted estimates and invalidates from their earlier date onward", async (t) => {
  const state = database(t, [transaction("fund-a", "2026-10-05"), transaction("fund-b", "2026-10-01")]);
  const result = await confirmPurchaseEvent("event-1", {
    trade_date: "2026-10-10", transactions: [transaction("fund-a")]
  });
  assert.deepEqual(result, { event_id: "event-1", confirmed_transactions: 1 });
  assertConfirmed(state, ["fund-a"], "2026-10-01");
  assert.equal(state.transactions[0].trade_date, "2026-10-10");
});

test("confirming all funds updates their values and includes previous dates in invalidation", async (t) => {
  const state = database(t, [transaction("fund-a", "2026-10-02"), transaction("fund-b", "2026-10-04")]);
  const result = await confirmPurchaseEvent("event-1", {
    trade_date: "2026-10-10",
    transactions: [{ ...transaction("fund-a"), units_delta: "45" }, transaction("fund-b", "2026-10-12")]
  });
  assert.equal(result.confirmed_transactions, 2);
  assertConfirmed(state, ["fund-a", "fund-b"], "2026-10-02");
  assert.equal(state.transactions[0].units_delta, "45.0000000000");
  assert.equal(state.transactions[1].trade_date, "2026-10-12");
});

test("an earlier per-fund confirmed date starts invalidation before all old dates", async (t) => {
  const state = database(t, [transaction("fund-a", "2026-10-05")]);
  await confirmPurchaseEvent("event-1", {
    trade_date: "2026-10-10", transactions: [transaction("fund-a", "2026-09-30")]
  });
  assertConfirmed(state, ["fund-a"], "2026-09-30");
});

test("confirmation can add funds when no estimates exist", async (t) => {
  const state = database(t, []);
  await confirmPurchaseEvent("event-1", {
    trade_date: "2026-10-10", transactions: [transaction("fund-a")]
  });
  assertConfirmed(state, ["fund-a"], "2026-10-10");
});

test("reconfirmation replaces omitted previously confirmed funds too", async (t) => {
  const state = database(t, [transaction("fund-a", "2026-10-05", "CONFIRMED"), transaction("fund-b", "2026-10-01", "CONFIRMED")]);
  await confirmPurchaseEvent("event-1", {
    trade_date: "2026-10-10", transactions: [transaction("fund-a")]
  });
  assertConfirmed(state, ["fund-a"], "2026-10-01");
});

test("invalid confirmation rolls back omitted-fund deletion", async (t) => {
  const original = [transaction("fund-a", "2026-10-05"), transaction("fund-b", "2026-10-01")];
  const state = database(t, original);
  await assert.rejects(confirmPurchaseEvent("event-1", {
    trade_date: "2026-10-10", transactions: [{ ...transaction("fund-a"), units_delta: "invalid" }]
  }), /Invalid decimal/);
  assert.deepEqual(state.transactions, original);
  assert.equal(state.status, "ESTIMATED");
  assert.deepEqual(state.invalidations, []);
  assert.equal(state.rolledBack, true);
  assert.equal(state.released, true);
});

test("a missing event returns 404 and rolls back", async (t) => {
  const state = database(t, [], { missingEvent: true });
  await assert.rejects(confirmPurchaseEvent("event-1", {
    trade_date: "2026-10-10", transactions: [transaction("fund-a")]
  }), { status: 404 });
  assert.equal(state.rolledBack, true);
  assert.equal(state.released, true);
});
