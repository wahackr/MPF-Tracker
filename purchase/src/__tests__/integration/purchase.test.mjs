import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

let database;
let processPurchases;
let confirmPurchaseEvent;
let closeDatabase;
let accountId;
let planId;
let fundId;
let secondFundId;

beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required for purchase tests");

  // The fixture connection inserts dummy data; the service uses its real, restricted database role.
  const url = new URL(connectionString);
  process.env.DB_HOST = url.hostname;
  process.env.DB_PORT = url.port || "5432";
  process.env.DB_NAME = decodeURIComponent(url.pathname.slice(1));
  process.env.DB_USER = process.env.PURCHASE_DB_USER ?? "mpf_purchase";
  process.env.DB_PASSWORD = process.env.PURCHASE_DB_PASSWORD ?? "REPLACE_ME_PURCHASE_PASSWORD";

  database = new Client({ connectionString });
  await database.connect();

  ({ processPurchases, confirmPurchaseEvent } = await import("../../../dist/main.js"));
  ({ closeDatabase } = await import("../../../dist/libs/db.js"));
});

beforeEach(async () => {
  // testing data
  accountId = randomUUID();
  planId = randomUUID();
  fundId = `TEST:${randomUUID()}`;
  secondFundId = `TEST:${randomUUID()}`;

  await database.query(
    `INSERT INTO mpf.funds (fund_id, provider, provider_fund_code, name, currency)
     VALUES ($1, 'test', $1, 'Test fund', 'HKD'), ($2, 'test', $2, 'Second test fund', 'HKD')`,
    [fundId, secondFundId]
  );

  await database.query(
    `INSERT INTO mpf.accounts (account_id, provider, scheme, display_label, currency)
     VALUES ($1, 'test', 'test', 'Test account', 'HKD')`,
    [accountId]
  );

  await database.query(
    `INSERT INTO mpf.contribution_plans
       (plan_id, account_id, contribution_stream, amount, expected_day, effective_from)
     VALUES ($1, $2, 'employee', 100, 10, '2026-10-01')`,
    [planId, accountId]
  );

  await database.query(
    `INSERT INTO mpf.allocation_rules (account_id, fund_id, contribution_stream, effective_from, weight)
     VALUES ($1, $2, 'employee', '2026-10-01', 100)`,
    [accountId, fundId]
  );

  await database.query(
    `INSERT INTO mpf.fund_prices (fund_id, price_date, bid, offer, source, fetched_at)
     VALUES ($1, '2026-10-15', 10, 10, 'test', NOW()), ($2, '2026-10-15', 10, 10, 'test', NOW())`,
    [fundId, secondFundId]
  );
});

afterEach(async () => {
  // Remove only this test's committed fixtures and results; account deletion cascades to its events and trades.
  await database.query("DELETE FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]);
  await database.query("DELETE FROM mpf.accounts WHERE account_id = $1", [accountId]);
  await database.query("DELETE FROM mpf.fund_prices WHERE fund_id = ANY($1::text[])", [[fundId, secondFundId]]);
  await database.query("DELETE FROM mpf.funds WHERE fund_id = ANY($1::text[])", [[fundId, secondFundId]]);
});

afterAll(async () => {
  await closeDatabase?.();
  await database?.end();
});

test("processPurchases returns counts and commits the expected rows", async () => {
  // test
  const result = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(result).toEqual({
    as_of_date: "2026-10-15", processed_events: 1, estimated_events: 1,
    waiting_events: 0, failed_events: 0, inserted_transactions: 1,
    updated_transactions: 0, waiting_details: []
  });

  const events = await database.query(
    "SELECT status, expected_date::text, amount::text FROM mpf.contribution_events WHERE plan_id = $1", [planId]
  );
  expect(events.rows).toEqual([{ status: "ESTIMATED", expected_date: "2026-10-10", amount: "100.00000000" }]);

  const trades = await database.query(
    `SELECT fund_id, status, trade_date::text, cash_amount::text, unit_price::text, units_delta::text
     FROM mpf.purchase_transactions WHERE fund_id = $1`, [fundId]
  );
  expect(trades.rows).toEqual([{
    fund_id: fundId, status: "ESTIMATED", trade_date: "2026-10-15",
    cash_amount: "100.00000000", unit_price: "10.0000000000", units_delta: "10.0000000000"
  }]);

  const invalidations = await database.query(
    "SELECT reason, from_date::text, to_date::text FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]
  );
  expect(invalidations.rows).toEqual([{ reason: "purchase_estimation", from_date: "2026-10-10", to_date: null }]);
});

test("repeating a run leaves saved purchases and invalidations unchanged", async () => {
  // testing data
  await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // test
  const result = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(result).toMatchObject({ inserted_transactions: 0, updated_transactions: 0 });
  const trades = await database.query("SELECT count(*)::int AS count FROM mpf.purchase_transactions WHERE fund_id = $1", [fundId]);
  const invalidations = await database.query("SELECT count(*)::int AS count FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]);
  expect(trades.rows[0].count).toBe(1);
  expect(invalidations.rows[0].count).toBe(1);
});

test("a plan whose contribution is not due creates no event", async () => {
  // testing data
  await database.query("UPDATE mpf.contribution_plans SET expected_day = 20 WHERE plan_id = $1", [planId]);

  // test
  const result = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(result).toMatchObject({ processed_events: 0, inserted_transactions: 0 });
  const events = await database.query("SELECT event_id FROM mpf.contribution_events WHERE plan_id = $1", [planId]);
  expect(events.rows).toEqual([]);
});

test("historical runs include retired plans only within their effective dates", async () => {
  // testing data
  await database.query("UPDATE mpf.contribution_plans SET effective_to = '2026-10-20', active = FALSE WHERE plan_id = $1", [planId]);

  // test
  const historical = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });
  const expired = await processPurchases({ account_id: accountId, as_of_date: "2026-10-25" });

  // assert
  expect(historical).toMatchObject({ inserted_transactions: 1 });
  expect(expired).toMatchObject({ processed_events: 0 });
});

test.each([0, 90, -100])("missing or invalid allocation total %s requires review", async (weight) => {
  // testing data
  if (weight === 0) {
    await database.query("DELETE FROM mpf.allocation_rules WHERE account_id = $1", [accountId]);
  } else {
    await database.query("UPDATE mpf.allocation_rules SET weight = $2 WHERE account_id = $1", [accountId, weight]);
  }

  // test
  const result = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(result).toMatchObject({ failed_events: 1, inserted_transactions: 0 });
  const events = await database.query("SELECT status FROM mpf.contribution_events WHERE plan_id = $1", [planId]);
  expect(events.rows).toEqual([{ status: "FAILED_REVIEW" }]);
  const trades = await database.query("SELECT transaction_id FROM mpf.purchase_transactions WHERE fund_id = $1", [fundId]);
  expect(trades.rows).toEqual([]);
});

test("future prices remain unavailable until the run date reaches them", async () => {
  // test
  const early = await processPurchases({ account_id: accountId, as_of_date: "2026-10-10" });
  const later = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(early).toMatchObject({ waiting_events: 1, inserted_transactions: 0 });
  expect(later).toMatchObject({ inserted_transactions: 1 });
  const trades = await database.query("SELECT trade_date::text FROM mpf.purchase_transactions WHERE fund_id = $1", [fundId]);
  expect(trades.rows).toEqual([{ trade_date: "2026-10-15" }]);
});

test.each([null, 0, -1])("invalid price %s waits without saving a partial purchase", async (price) => {
  // testing data
  await database.query("UPDATE mpf.fund_prices SET bid = $2 WHERE fund_id = $1", [fundId, price]);

  // test
  const result = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(result).toMatchObject({ waiting_events: 1, inserted_transactions: 0 });
  const events = await database.query("SELECT event_id, status FROM mpf.contribution_events WHERE plan_id = $1", [planId]);
  expect(events.rows[0].status).toBe("WAITING_FOR_PRICE");
  expect(result.waiting_details).toEqual([{ event_id: events.rows[0].event_id, reason: "missing_price" }]);
  const trades = await database.query("SELECT transaction_id FROM mpf.purchase_transactions WHERE fund_id = $1", [fundId]);
  expect(trades.rows).toEqual([]);
});

test("prices beyond the 14 day estimation window remain unavailable", async () => {
  // testing data
  await database.query("UPDATE mpf.contribution_plans SET expected_day = 1 WHERE plan_id = $1", [planId]);
  await database.query("UPDATE mpf.fund_prices SET price_date = '2026-10-16' WHERE fund_id = $1", [fundId]);

  // test
  const result = await processPurchases({ account_id: accountId, as_of_date: "2026-10-20" });

  // assert
  expect(result).toMatchObject({ waiting_events: 1, inserted_transactions: 0 });
});

test("price corrections update estimated units and invalidate the account again", async () => {
  // testing data
  await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });
  await database.query("UPDATE mpf.fund_prices SET bid = 3 WHERE fund_id = $1", [fundId]);

  // test
  const result = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(result).toMatchObject({ inserted_transactions: 0, updated_transactions: 1 });
  const trades = await database.query("SELECT units_delta::text FROM mpf.purchase_transactions WHERE fund_id = $1", [fundId]);
  expect(trades.rows).toEqual([{ units_delta: "33.3333333333" }]);
  const invalidations = await database.query("SELECT count(*)::int AS count FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]);
  expect(invalidations.rows[0].count).toBe(2);
});

test("multiple plans use the current allocation version and invalidate the account once", async () => {
  // testing data
  await database.query(
    `INSERT INTO mpf.contribution_plans (account_id, contribution_stream, amount, expected_day, effective_from)
     VALUES ($1, 'employee', 100, 5, '2026-10-01')`, [accountId]
  );
  await database.query("UPDATE mpf.allocation_rules SET weight = 40 WHERE account_id = $1", [accountId]);
  await database.query(
    `INSERT INTO mpf.allocation_rules (account_id, fund_id, contribution_stream, effective_from, weight)
     VALUES ($1, $2, 'employee', '2026-10-01', 60), ($1, $3, 'employee', '2026-09-01', 100)`,
    [accountId, secondFundId, fundId]
  );

  // test
  const result = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(result).toMatchObject({ processed_events: 2, estimated_events: 2, inserted_transactions: 4 });
  const trades = await database.query(
    `SELECT t.fund_id, t.cash_amount::text, t.units_delta::text FROM mpf.purchase_transactions t
     JOIN mpf.contribution_events e USING (event_id) WHERE e.plan_id = $1 ORDER BY t.cash_amount`, [planId]
  );
  expect(trades.rows).toEqual([
    { fund_id: fundId, cash_amount: "40.00000000", units_delta: "4.0000000000" },
    { fund_id: secondFundId, cash_amount: "60.00000000", units_delta: "6.0000000000" }
  ]);
  const invalidations = await database.query("SELECT from_date::text FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]);
  expect(invalidations.rows).toEqual([{ from_date: "2026-10-05" }]);
});

test("confirmation replaces obsolete funds and invalidates the earliest removed trade", async () => {
  // testing data
  await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });
  const { rows: [event] } = await database.query("SELECT event_id FROM mpf.contribution_events WHERE plan_id = $1", [planId]);
  await database.query(
    `INSERT INTO mpf.purchase_transactions (event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy)
     VALUES ($1, $2, '2026-10-02', 100, 10, 10, 'ESTIMATED', 'test')`, [event.event_id, secondFundId]
  );
  const payload = {
    trade_date: "2026-10-20",
    transactions: [{ fund_id: fundId, cash_amount: "100", unit_price: "20", units_delta: "5" }]
  };

  // test
  const result = await confirmPurchaseEvent(event.event_id, payload);

  // assert
  expect(result).toEqual({ event_id: event.event_id, confirmed_transactions: 1 });
  const trades = await database.query("SELECT fund_id, status, units_delta::text FROM mpf.purchase_transactions WHERE event_id = $1", [event.event_id]);
  expect(trades.rows).toEqual([{ fund_id: fundId, status: "CONFIRMED", units_delta: "5.0000000000" }]);
  const invalidations = await database.query("SELECT from_date::text FROM mpf.snapshot_invalidation_requests WHERE account_id = $1 AND reason = 'purchase_confirmation'", [accountId]);
  expect(invalidations.rows).toEqual([{ from_date: "2026-10-02" }]);
});

test("confirmed events and trades survive later estimation", async () => {
  // testing data
  await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });
  const { rows: [event] } = await database.query("SELECT event_id FROM mpf.contribution_events WHERE plan_id = $1", [planId]);
  await confirmPurchaseEvent(event.event_id, {
    trade_date: "2026-10-16",
    transactions: [{ fund_id: fundId, cash_amount: "100", unit_price: "20", units_delta: "5" }]
  });

  // test
  const confirmed = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });
  await database.query("UPDATE mpf.contribution_events SET status = 'EXPECTED' WHERE event_id = $1", [event.event_id]);
  const pending = await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(confirmed).toMatchObject({ processed_events: 1, estimated_events: 0 });
  expect(pending).toMatchObject({ inserted_transactions: 0, updated_transactions: 0 });
  const trades = await database.query("SELECT status, units_delta::text FROM mpf.purchase_transactions WHERE event_id = $1", [event.event_id]);
  expect(trades.rows).toEqual([{ status: "CONFIRMED", units_delta: "5.0000000000" }]);
});

test("failed confirmation rolls back deletions and preserves committed estimates", async () => {
  // testing data
  await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });
  const { rows: [event] } = await database.query("SELECT event_id FROM mpf.contribution_events WHERE plan_id = $1", [planId]);
  const payload = {
    trade_date: "2026-10-20",
    transactions: [{ fund_id: "missing-fund", cash_amount: "100", unit_price: "10", units_delta: "10" }]
  };

  // test
  let failure;
  try {
    await confirmPurchaseEvent(event.event_id, payload);
  } catch (error) {
    failure = error;
  }

  // assert
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toMatch(/foreign key constraint/);
  const trades = await database.query("SELECT fund_id, status FROM mpf.purchase_transactions WHERE event_id = $1", [event.event_id]);
  expect(trades.rows).toEqual([{ fund_id: fundId, status: "ESTIMATED" }]);
  const invalidations = await database.query("SELECT reason FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]);
  expect(invalidations.rows).toEqual([{ reason: "purchase_estimation" }]);
});

test.each([
  [{ fund_id: " " }, /fund_id is required/],
  [{ cash_amount: "invalid" }, /Invalid decimal/],
  [{ unit_price: "invalid" }, /Invalid decimal/],
  [{ units_delta: "invalid" }, /Invalid decimal/]
])("invalid confirmation values leave the saved estimate intact: %j", async (override, message) => {
  // testing data
  await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });
  const { rows: [event] } = await database.query("SELECT event_id FROM mpf.contribution_events WHERE plan_id = $1", [planId]);
  const payload = {
    trade_date: "2026-10-20",
    transactions: [{ fund_id: fundId, cash_amount: "100", unit_price: "10", units_delta: "10", ...override }]
  };

  // test
  const operation = confirmPurchaseEvent(event.event_id, payload);

  // assert
  await expect(operation).rejects.toThrow(message);
  const trades = await database.query("SELECT fund_id, status FROM mpf.purchase_transactions WHERE event_id = $1", [event.event_id]);
  expect(trades.rows).toEqual([{ fund_id: fundId, status: "ESTIMATED" }]);
});

test("duplicate confirmation funds are rejected without changing saved trades", async () => {
  // testing data
  await processPurchases({ account_id: accountId, as_of_date: "2026-10-15" });
  const { rows: [event] } = await database.query("SELECT event_id FROM mpf.contribution_events WHERE plan_id = $1", [planId]);
  const transaction = { fund_id: fundId, cash_amount: "100", unit_price: "10", units_delta: "10" };

  // test
  const operation = confirmPurchaseEvent(event.event_id, {
    trade_date: "2026-10-20", transactions: [transaction, transaction]
  });

  // assert
  await expect(operation).rejects.toThrow(/unique/);
  const trades = await database.query("SELECT status FROM mpf.purchase_transactions WHERE event_id = $1", [event.event_id]);
  expect(trades.rows).toEqual([{ status: "ESTIMATED" }]);
});

test("confirming a missing event returns 404", async () => {
  // testing data
  const eventId = randomUUID();
  const payload = {
    trade_date: "2026-10-20",
    transactions: [{ fund_id: fundId, cash_amount: "100", unit_price: "10", units_delta: "10" }]
  };

  // test
  const operation = confirmPurchaseEvent(eventId, payload);

  // assert
  await expect(operation).rejects.toMatchObject({ status: 404 });
});
