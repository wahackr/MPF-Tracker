import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";

let database;
let app;
let calculatePortfolioAsOf;
let persistSnapshot;
let applyPendingInvalidations;
let snapshotHistory;
let listStaleSnapshotDates;
let listSnapshotDatesInRange;
let closeDatabase;
let accountId;
let accountIds;
let fundId;
let secondFundId;
let planId;
let eventId;
let globalInvalidationId;
const apiKey = "valuation-test-key";

beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required for valuation tests");

  // Fixtures use the admin connection; calculations and writes use the actual valuation role.
  const url = new URL(connectionString);
  process.env.API_KEY = apiKey;
  process.env.DB_HOST = url.hostname;
  process.env.DB_PORT = url.port || "5432";
  process.env.DB_NAME = decodeURIComponent(url.pathname.slice(1));
  process.env.DB_USER = process.env.VALUATION_DB_USER ?? "mpf_valuation";
  process.env.DB_PASSWORD = process.env.VALUATION_DB_PASSWORD ?? "REPLACE_ME_VALUATION_PASSWORD";

  database = new Client({ connectionString });
  await database.connect();
  ({ calculatePortfolioAsOf } = await import("../../../dist/main.js"));
  ({ persistSnapshot, applyPendingInvalidations, snapshotHistory, listStaleSnapshotDates, listSnapshotDatesInRange } = await import("../../../dist/libs/repository.js"));
  ({ app } = await import("../../../dist/app.js"));
  ({ closeDatabase } = await import("../../../dist/libs/db.js"));
});

beforeEach(async () => {
  // testing data
  accountId = randomUUID();
  accountIds = [accountId];
  fundId = `TEST:${randomUUID()}`;
  secondFundId = `TEST:${randomUUID()}`;
  planId = randomUUID();
  eventId = randomUUID();
  globalInvalidationId = null;

  await database.query(
    `INSERT INTO mpf.funds (fund_id, provider, provider_fund_code, name, currency)
     VALUES ($1, 'test', $1, 'First test fund', 'HKD'), ($2, 'test', $2, 'Second test fund', 'HKD')`,
    [fundId, secondFundId]
  );

  await database.query(
    `INSERT INTO mpf.accounts (account_id, provider, scheme, display_label, currency)
     VALUES ($1, 'test', 'test', 'Test account', 'HKD')`, [accountId]
  );

  await database.query(
    `INSERT INTO mpf.holdings_baselines (account_id, fund_id, effective_date, units, source, verification_status)
     VALUES ($1, $2, '2026-10-01', 100, 'test', 'VERIFIED')`, [accountId, fundId]
  );

  await database.query(
    `INSERT INTO mpf.contribution_plans (plan_id, account_id, contribution_stream, amount, expected_day, effective_from)
     VALUES ($1, $2, 'employee', 100, 10, '2026-10-01')`, [planId, accountId]
  );

  await database.query(
    `INSERT INTO mpf.contribution_events (event_id, plan_id, period, expected_date, amount, status)
     VALUES ($1, $2, '2026-10-01', '2026-10-10', 100, 'ESTIMATED')`, [eventId, planId]
  );

  await database.query(
    `INSERT INTO mpf.purchase_transactions (event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy)
     VALUES ($1, $2, '2026-10-15', 20, 10, 2, 'CONFIRMED', 'test')`, [eventId, fundId]
  );

  // A separate contribution event allows a second transaction in the same fund.
  await database.query(
    `WITH event AS (
       INSERT INTO mpf.contribution_events (plan_id, period, expected_date, amount, status)
       VALUES ($1, '2026-11-01', '2026-10-10', 30, 'ESTIMATED') RETURNING event_id
     )
     INSERT INTO mpf.purchase_transactions (event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy)
     SELECT event_id, $2, '2026-10-15', 30, 10, 3, 'ESTIMATED', 'test' FROM event`, [planId, fundId]
  );

  await database.query(
    `INSERT INTO mpf.fund_prices (fund_id, price_date, bid, offer, source, fetched_at)
     VALUES ($1, '2026-10-15', 10, 11, 'test', NOW())`, [fundId]
  );
});

afterEach(async () => {
  // Only remove rows created by this test; account deletion cascades through snapshots and trades.
  if (globalInvalidationId) await database.query("DELETE FROM mpf.snapshot_invalidation_requests WHERE invalidation_id = $1", [globalInvalidationId]);
  await database.query("DELETE FROM mpf.accounts WHERE account_id = ANY($1::uuid[])", [accountIds]);
  await database.query("DELETE FROM mpf.fund_prices WHERE fund_id = ANY($1::text[])", [[fundId, secondFundId]]);
  await database.query("DELETE FROM mpf.funds WHERE fund_id = ANY($1::text[])", [[fundId, secondFundId]]);
});

afterAll(async () => {
  await closeDatabase?.();
  await database?.end();
});

test("calculation combines baseline, confirmed and estimated units with the as-of bid price", async () => {
  // test
  const result = await calculatePortfolioAsOf("2026-10-15", accountId);

  // assert
  expect(result).toMatchObject({
    requested_as_of: "2026-10-15", calculation_status: "COMPLETE",
    total_value: "1050.00000000", priced_subtotal: "1050.00000000", unpriced_fund_count: 0
  });
  expect(result.accounts).toHaveLength(1);
  expect(result.accounts[0].funds).toEqual([expect.objectContaining({
    fund_id: fundId, units: "105.0000000000", units_status: "ESTIMATED",
    price: "10.0000000000", price_status: "FRESH", market_value: "1050.00000000"
  })]);
  const snapshots = await database.query("SELECT snapshot_id FROM mpf.portfolio_snapshots WHERE account_id = $1", [accountId]);
  expect(snapshots.rows).toEqual([]);
});

test("excluding estimates retains confirmed purchases", async () => {
  // test
  const result = await calculatePortfolioAsOf("2026-10-15", accountId, false);

  // assert
  expect(result.total_value).toBe("1020.00000000");
  expect(result.accounts[0].funds[0]).toMatchObject({ units: "102.0000000000", units_status: "VERIFIED" });
});

test("future prices and future trades cannot enter an earlier calculation", async () => {
  // test
  const result = await calculatePortfolioAsOf("2026-10-10", accountId);

  // assert
  expect(result).toMatchObject({ calculation_status: "PARTIAL", total_value: null, priced_subtotal: "0.00000000", unpriced_fund_count: 1 });
  expect(result.accounts[0].funds[0]).toMatchObject({ units: "100.0000000000", price_status: "MISSING", price: null });
});

test("latest eligible baseline replaces earlier balances without double-counting", async () => {
  // testing data
  await database.query(
    `INSERT INTO mpf.holdings_baselines (account_id, fund_id, effective_date, units, source, verification_status)
     VALUES ($1, $2, '2026-10-10', 200, 'test', 'VERIFIED'), ($1, $2, '2026-10-20', 500, 'test', 'VERIFIED')`, [accountId, fundId]
  );

  // test
  const result = await calculatePortfolioAsOf("2026-10-15", accountId);

  // assert
  expect(result.total_value).toBe("2050.00000000");
  expect(result.accounts[0].funds[0]).toMatchObject({ baseline_date: "2026-10-10", units: "205.0000000000" });
});

test("trades on the baseline date and funds without a baseline are excluded", async () => {
  // testing data
  await database.query("UPDATE mpf.purchase_transactions SET trade_date = '2026-10-01' WHERE event_id = $1", [eventId]);
  await database.query(
    `INSERT INTO mpf.purchase_transactions (event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy)
     VALUES ($1, $2, '2026-10-15', 100, 10, 10, 'CONFIRMED', 'test')`, [eventId, secondFundId]
  );

  // test
  const result = await calculatePortfolioAsOf("2026-10-15", accountId);

  // assert
  expect(result.total_value).toBe("1030.00000000");
  expect(result.accounts[0].funds).toHaveLength(1);
});

test("a missing fund price makes the total partial while retaining the priced subtotal", async () => {
  // testing data
  await database.query(
    `INSERT INTO mpf.holdings_baselines (account_id, fund_id, effective_date, units, source, verification_status)
     VALUES ($1, $2, '2026-10-01', 20, 'test', 'ESTIMATED')`, [accountId, secondFundId]
  );

  // test
  const result = await calculatePortfolioAsOf("2026-10-15", accountId);

  // assert
  expect(result).toMatchObject({ calculation_status: "PARTIAL", total_value: null, priced_subtotal: "1050.00000000", unpriced_fund_count: 1 });
  expect(result.accounts[0].calculation_status).toBe("PARTIAL");
  expect(result.accounts[0].funds.find((fund) => fund.fund_id === secondFundId)).toMatchObject({ price_status: "MISSING", units_status: "ESTIMATED" });
});

test.each([null, 0, -1])("unusable bid %s cannot produce a market value", async (price) => {
  // testing data
  await database.query("UPDATE mpf.fund_prices SET bid = $2 WHERE fund_id = $1", [fundId, price]);

  // test
  const result = await calculatePortfolioAsOf("2026-10-15", accountId);

  // assert
  expect(result.total_value).toBeNull();
  expect(result.accounts[0].funds[0].price_status).toBe("MISSING");
});

test("old prices make both account and aggregate stale", async () => {
  // testing data
  await database.query("UPDATE mpf.fund_prices SET price_date = '2026-10-01' WHERE fund_id = $1", [fundId]);

  // test
  const result = await calculatePortfolioAsOf("2026-10-15", accountId);

  // assert
  expect(result).toMatchObject({ calculation_status: "STALE", total_value: "1050.00000000" });
  expect(result.accounts[0].calculation_status).toBe("STALE");
  expect(result.accounts[0].funds[0]).toMatchObject({ price_status: "STALE", days_stale: 14 });
});

test("aggregate valuation includes multiple accounts while account filtering isolates one", async () => {
  // testing data
  const secondAccount = randomUUID();
  accountIds.push(secondAccount);
  await database.query(
    `INSERT INTO mpf.accounts (account_id, provider, scheme, display_label, currency)
     VALUES ($1, 'test', 'test', 'Second account', 'HKD')`, [secondAccount]
  );
  await database.query(
    `INSERT INTO mpf.holdings_baselines (account_id, fund_id, effective_date, units, source, verification_status)
     VALUES ($1, $2, '2026-10-01', 100, 'test', 'VERIFIED')`, [secondAccount, fundId]
  );

  // test
  const aggregate = await calculatePortfolioAsOf("2026-10-15");
  const filtered = await calculatePortfolioAsOf("2026-10-15", secondAccount);
  const empty = await calculatePortfolioAsOf("2026-10-15", randomUUID());
  const saved = await persistSnapshot(aggregate);

  // assert
  expect(aggregate.total_value).toBe("2050.00000000");
  expect(aggregate.accounts.map((account) => account.account_id)).toEqual([...accountIds].sort());
  expect(filtered.total_value).toBe("1000.00000000");
  expect(filtered.accounts).toHaveLength(1);
  expect(empty).toMatchObject({ total_value: "0.00000000", accounts: [] });
  expect(saved).toEqual({ saved_accounts: 2 });
  const snapshots = await database.query("SELECT account_id, total_value::text FROM mpf.portfolio_snapshots WHERE account_id = ANY($1::uuid[])", [accountIds]);
  expect(snapshots.rows).toEqual(expect.arrayContaining([
    { account_id: accountId, total_value: "1050.00000000" },
    { account_id: secondAccount, total_value: "1000.00000000" }
  ]));
  expect(snapshots.rows).toHaveLength(2);
});

test("snapshot persistence commits account totals and fund values and increments revisions", async () => {
  // testing data
  const calculation = await calculatePortfolioAsOf("2026-10-15", accountId);

  // test
  const first = await persistSnapshot(calculation);
  const repeated = await persistSnapshot(calculation);

  // assert
  expect(first).toEqual({ saved_accounts: 1 });
  expect(repeated).toEqual({ saved_accounts: 1 });
  const snapshots = await database.query("SELECT total_value::text, revision, stale FROM mpf.portfolio_snapshots WHERE account_id = $1", [accountId]);
  expect(snapshots.rows).toEqual([{ total_value: "1050.00000000", revision: 2, stale: false }]);
  const funds = await database.query("SELECT units::text, price_used::text, value::text FROM mpf.snapshot_fund_values WHERE account_id = $1", [accountId]);
  expect(funds.rows).toEqual([{ units: "105.0000000000", price_used: "10.0000000000", value: "1050.00000000" }]);
});

test("saving a new fund set removes obsolete snapshot funds", async () => {
  // testing data
  const calculation = await calculatePortfolioAsOf("2026-10-15", accountId);
  await persistSnapshot(calculation);
  calculation.accounts[0].funds = [];
  calculation.accounts[0].total_value = "0.00000000";

  // test
  const result = await persistSnapshot(calculation);

  // assert
  expect(result.saved_accounts).toBe(1);
  const funds = await database.query("SELECT fund_id FROM mpf.snapshot_fund_values WHERE account_id = $1", [accountId]);
  expect(funds.rows).toEqual([]);
});

test("failed snapshot writes roll back the revision, totals and removed fund rows", async () => {
  // testing data
  const calculation = await calculatePortfolioAsOf("2026-10-15", accountId);
  await persistSnapshot(calculation);
  calculation.accounts[0].total_value = "999";
  calculation.accounts[0].funds[0].fund_id = "missing-fund";

  // test
  const operation = persistSnapshot(calculation);

  // assert
  await expect(operation).rejects.toThrow(/foreign key constraint/);
  const snapshots = await database.query("SELECT total_value::text, revision FROM mpf.portfolio_snapshots WHERE account_id = $1", [accountId]);
  expect(snapshots.rows).toEqual([{ total_value: "1050.00000000", revision: 1 }]);
  const funds = await database.query("SELECT fund_id FROM mpf.snapshot_fund_values WHERE account_id = $1", [accountId]);
  expect(funds.rows).toEqual([{ fund_id: fundId }]);
});

test("an empty calculation saves no snapshots", async () => {
  // testing data
  const calculation = await calculatePortfolioAsOf("2026-10-15", randomUUID());

  // test
  const result = await persistSnapshot(calculation);

  // assert
  expect(result).toEqual({ saved_accounts: 0 });
});

test("invalidations respect date bounds and are processed only once", async () => {
  // testing data
  await persistSnapshot(await calculatePortfolioAsOf("2026-10-15", accountId));
  await persistSnapshot(await calculatePortfolioAsOf("2026-10-16", accountId));
  await persistSnapshot(await calculatePortfolioAsOf("2026-10-17", accountId));
  await database.query(
    `INSERT INTO mpf.snapshot_invalidation_requests (source_service, reason, account_id, from_date, to_date)
     VALUES ('test', 'test', $1, '2026-10-16', '2026-10-16')`, [accountId]
  );

  // test
  const applied = await applyPendingInvalidations(accountId);
  const repeated = await applyPendingInvalidations(accountId);
  const staleDates = await listStaleSnapshotDates(accountId);
  const rangeDates = await listSnapshotDatesInRange("2026-10-16", "2026-10-17", accountId);
  const history = await snapshotHistory("2026-10-16", "2026-10-16", accountId);

  // assert
  expect(applied).toBe(1);
  expect(repeated).toBe(0);
  expect(staleDates).toEqual(["2026-10-16"]);
  expect(rangeDates).toEqual(["2026-10-16", "2026-10-17"]);
  expect(history).toHaveLength(1);
  expect(history[0].as_of_date).toBe("2026-10-16");
  const processed = await database.query("SELECT processed_at IS NOT NULL AS processed FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]);
  expect(processed.rows).toEqual([{ processed: true }]);
});

test("a global invalidation with open date bounds marks saved snapshots stale", async () => {
  // testing data
  await persistSnapshot(await calculatePortfolioAsOf("2026-10-15", accountId));
  globalInvalidationId = randomUUID();
  await database.query(
    "INSERT INTO mpf.snapshot_invalidation_requests (invalidation_id, source_service, reason) VALUES ($1, 'test', 'global')", [globalInvalidationId]
  );

  // test
  const result = await applyPendingInvalidations();

  // assert
  expect(result).toBe(1);
  const snapshots = await database.query("SELECT stale FROM mpf.portfolio_snapshots WHERE account_id = $1", [accountId]);
  expect(snapshots.rows).toEqual([{ stale: true }]);
});

test("snapshot HTTP endpoint returns saved counts and persists the real calculation", async () => {
  // test
  const response = await request(app).post("/v1/valuation/snapshot").set("X-API-Key", apiKey)
    .send({ account_id: accountId, as_of_date: "2026-10-15" });

  // assert
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ requested_as_of: "2026-10-15", saved_accounts: 1, calculation_status: "COMPLETE", unpriced_fund_count: 0 });
  const snapshots = await database.query("SELECT total_value::text FROM mpf.portfolio_snapshots WHERE account_id = $1", [accountId]);
  expect(snapshots.rows).toEqual([{ total_value: "1050.00000000" }]);
});

test("rebuild processes invalidations and replaces stale values using corrected prices", async () => {
  // testing data
  await persistSnapshot(await calculatePortfolioAsOf("2026-10-15", accountId));
  await database.query("UPDATE mpf.fund_prices SET bid = 20 WHERE fund_id = $1", [fundId]);
  await database.query(
    "INSERT INTO mpf.snapshot_invalidation_requests (source_service, reason, account_id, from_date) VALUES ('test', 'correction', $1, '2026-10-15')", [accountId]
  );

  // test
  const response = await request(app).post("/v1/valuation/rebuild").set("X-API-Key", apiKey).send({ account_id: accountId });

  // assert
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ rebuilt_dates: ["2026-10-15"], rebuilt_count: 1, invalidations_applied: 1 });
  const snapshots = await database.query("SELECT total_value::text, revision, stale FROM mpf.portfolio_snapshots WHERE account_id = $1", [accountId]);
  expect(snapshots.rows).toEqual([{ total_value: "2100.00000000", revision: 2, stale: false }]);
});

test("as-of and history HTTP endpoints return real calculated and saved data", async () => {
  // testing data
  await persistSnapshot(await calculatePortfolioAsOf("2026-10-15", accountId));

  // test
  const asOf = await request(app).get("/v1/valuation/as-of").set("X-API-Key", apiKey)
    .query({ date: "2026-10-15", account_id: accountId, include_estimated: "false" });
  const history = await request(app).get("/v1/valuation/history").set("X-API-Key", apiKey)
    .query({ account_id: accountId, from_date: "2026-10-15", to_date: "2026-10-15" });
  const health = await request(app).get("/health");

  // assert
  expect(asOf.status).toBe(200);
  expect(asOf.body.total_value).toBe("1020.00000000");
  expect(history.status).toBe(200);
  expect(history.body.count).toBe(1);
  expect(history.body.items[0].total_value).toBe("1050.00000000");
  expect(health.body).toEqual({ service: "valuation", status: "ready", database: "up" });
});

test("HTTP endpoints reject missing authentication and invalid dates", async () => {
  // test
  const unauthorized = await request(app).post("/v1/valuation/snapshot").send({});
  const invalidDate = await request(app).get("/v1/valuation/as-of").set("X-API-Key", apiKey).query({ date: "invalid" });
  const invalidPayload = await request(app).post("/v1/valuation/snapshot").set("X-API-Key", apiKey).send({ account_id: "invalid" });

  // assert
  expect(unauthorized.status).toBe(401);
  expect(invalidDate.status).toBe(400);
  expect(invalidPayload.status).toBe(400);
});
