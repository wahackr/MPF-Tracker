import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";

let database;
let app;
let closeDatabase;
let accountId;
let accountIds;
let fundId;
let secondFundId;
const apiKey = "portfolio-test-key";

beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required for portfolio tests");

  // Use separate admin fixtures and real portfolio-role connections to verify committed results.
  const url = new URL(connectionString);
  process.env.API_KEY = apiKey;
  process.env.DB_HOST = url.hostname;
  process.env.DB_PORT = url.port || "5432";
  process.env.DB_NAME = decodeURIComponent(url.pathname.slice(1));
  process.env.DB_USER = process.env.PORTFOLIO_DB_USER ?? "mpf_portfolio";
  process.env.DB_PASSWORD = process.env.PORTFOLIO_DB_PASSWORD ?? "REPLACE_ME_PORTFOLIO_PASSWORD";

  database = new Client({ connectionString });
  await database.connect();
  ({ app } = await import("../../../dist/app.js"));
  ({ closeDatabase } = await import("../../../dist/libs/db.js"));
});

beforeEach(async () => {
  // testing data
  accountId = randomUUID();
  accountIds = [accountId];
  fundId = `TEST:${randomUUID()}`;
  secondFundId = `TEST:${randomUUID()}`;

  await database.query(
    `INSERT INTO mpf.funds (fund_id, provider, provider_fund_code, name, currency)
     VALUES ($1, 'test', $1, 'First test fund', 'HKD'), ($2, 'test', $2, 'Second test fund', 'HKD')`,
    [fundId, secondFundId]
  );

  await database.query(
    `INSERT INTO mpf.accounts (account_id, provider, scheme, display_label, currency)
     VALUES ($1, 'test', 'test', 'Test account', 'HKD')`, [accountId]
  );
});

afterEach(async () => {
  // Account deletion also removes the test's baselines, plans, reconciliations and invalidations.
  await database.query("DELETE FROM mpf.accounts WHERE account_id = ANY($1::uuid[])", [accountIds]);
  await database.query("DELETE FROM mpf.funds WHERE fund_id = ANY($1::text[])", [[fundId, secondFundId]]);
});

afterAll(async () => {
  await closeDatabase?.();
  await database?.end();
});

test("health checks the real database without authentication", async () => {
  // test
  const response = await request(app).get("/health");

  // assert
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ service: "portfolio", status: "ready", database: "up" });
});

test("account writes require an API key", async () => {
  // test
  const response = await request(app).post("/v1/accounts").send({});

  // assert
  expect(response.status).toBe(401);
});

test("account creation commits defaults and supports subsequent updates and reads", async () => {
  // testing data
  const payload = { provider: "test", scheme: "test", display_label: "Created account" };

  // test
  const created = await request(app).post("/v1/accounts").set("X-API-Key", apiKey).send(payload);
  if (created.body.account_id) accountIds.push(created.body.account_id);
  const updated = await request(app).put(`/v1/accounts/${created.body.account_id}`)
    .set("X-API-Key", apiKey).send({ display_label: "Updated account", currency: "usd", active: false });
  const fetched = await request(app).get(`/v1/accounts/${created.body.account_id}`).set("X-API-Key", apiKey);

  // assert
  expect(created.status).toBe(201);
  expect(created.body.currency).toBe("HKD");
  expect(updated.status).toBe(200);
  expect(fetched.body).toMatchObject({ display_label: "Updated account", currency: "USD", active: false });
  const saved = await database.query("SELECT display_label, currency, active FROM mpf.accounts WHERE account_id = $1", [created.body.account_id]);
  expect(saved.rows).toEqual([{ display_label: "Updated account", currency: "USD", active: false }]);
});

test("an empty account update returns 400", async () => {
  // test
  const response = await request(app).put(`/v1/accounts/${accountId}`).set("X-API-Key", apiKey).send({});

  // assert
  expect(response.status).toBe(400);
});

test.each(["", "/holdings", "/allocation-rules", "/contribution-plans", "/reconciliations", "/contribution-history"])(
  "missing account returns 404 for %s", async (suffix) => {
    // testing data
    const missingAccount = randomUUID();

    // test
    const response = await request(app).get(`/v1/accounts/${missingAccount}${suffix}`).set("X-API-Key", apiKey);

    // assert
    expect(response.status).toBe(404);
  }
);

test("baseline writes commit every holding and one snapshot invalidation", async () => {
  // testing data
  const payload = {
    effective_date: "2026-10-01", source: "statement", verification_status: "VERIFIED",
    holdings: [{ fund_id: fundId, units: "0.1000000001" }, { fund_id: secondFundId, units: "20" }]
  };

  // test
  const response = await request(app).post(`/v1/accounts/${accountId}/baselines`).set("X-API-Key", apiKey).send(payload);
  const listed = await request(app).get(`/v1/accounts/${accountId}/holdings`).set("X-API-Key", apiKey);

  // assert
  expect(response.status).toBe(200);
  expect(response.body.inserted_baselines).toBe(2);
  expect(listed.body.items).toHaveLength(2);
  const saved = await database.query("SELECT units::text FROM mpf.holdings_baselines WHERE account_id = $1 ORDER BY units", [accountId]);
  expect(saved.rows).toEqual([{ units: "0.1000000001" }, { units: "20.0000000000" }]);
  const invalidations = await database.query("SELECT reason, from_date::text FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]);
  expect(invalidations.rows).toEqual([{ reason: "baseline_update", from_date: "2026-10-01" }]);
});

test("invalid baseline funds roll back the complete batch", async () => {
  // testing data
  const payload = {
    effective_date: "2026-10-01", source: "statement", verification_status: "VERIFIED",
    holdings: [{ fund_id: fundId, units: "10" }, { fund_id: "missing-fund", units: "20" }]
  };

  // test
  const response = await request(app).post(`/v1/accounts/${accountId}/baselines`).set("X-API-Key", apiKey).send(payload);

  // assert
  expect(response.status).toBe(500);
  expect(response.body.detail).toMatch(/Fund not found/);
  const saved = await database.query("SELECT baseline_id FROM mpf.holdings_baselines WHERE account_id = $1", [accountId]);
  const invalidations = await database.query("SELECT invalidation_id FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]);
  expect(saved.rows).toEqual([]);
  expect(invalidations.rows).toEqual([]);
});

test("allocation updates retire the old version and commit all new weights", async () => {
  // testing data
  await database.query(
    `INSERT INTO mpf.allocation_rules (account_id, fund_id, contribution_stream, effective_from, weight)
     VALUES ($1, $2, 'employee', '2026-09-01', 100)`, [accountId, fundId]
  );
  const payload = {
    effective_from: "2026-10-01", contribution_stream: "EMPLOYEE",
    allocations: [{ fund_id: fundId, weight: "33.3" }, { fund_id: secondFundId, weight: "66.7" }]
  };

  // test
  const response = await request(app).put(`/v1/accounts/${accountId}/allocation-rules`).set("X-API-Key", apiKey).send(payload);
  const listed = await request(app).get(`/v1/accounts/${accountId}/allocation-rules`).set("X-API-Key", apiKey);

  // assert
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ allocation_count: 2, contribution_stream: "employee" });
  expect(listed.body.items).toHaveLength(3);
  const saved = await database.query("SELECT effective_to::text, weight::text FROM mpf.allocation_rules WHERE account_id = $1 ORDER BY effective_from, weight", [accountId]);
  expect(saved.rows).toEqual([
    { effective_to: "2026-09-30", weight: "100.0000000000" },
    { effective_to: null, weight: "33.3000000000" },
    { effective_to: null, weight: "66.7000000000" }
  ]);
});

test.each([[90], [110, -10]])("invalid allocation weights %j save no rows", async (...weights) => {
  // testing data
  const payload = {
    effective_from: "2026-10-01", contribution_stream: "employee",
    allocations: weights.map((weight, index) => ({ fund_id: index ? secondFundId : fundId, weight }))
  };

  // test
  const response = await request(app).put(`/v1/accounts/${accountId}/allocation-rules`).set("X-API-Key", apiKey).send(payload);

  // assert
  expect(response.status).toBe(400);
  const saved = await database.query("SELECT rule_id FROM mpf.allocation_rules WHERE account_id = $1", [accountId]);
  expect(saved.rows).toEqual([]);
});

test("a missing allocation fund rolls back retirement of the previous version", async () => {
  // testing data
  await database.query(
    `INSERT INTO mpf.allocation_rules (account_id, fund_id, contribution_stream, effective_from, weight)
     VALUES ($1, $2, 'employee', '2026-09-01', 100)`, [accountId, fundId]
  );

  // test
  const response = await request(app).put(`/v1/accounts/${accountId}/allocation-rules`).set("X-API-Key", apiKey).send({
    effective_from: "2026-10-01", contribution_stream: "employee", allocations: [{ fund_id: "missing-fund", weight: 100 }]
  });

  // assert
  expect(response.status).toBe(500);
  const saved = await database.query("SELECT effective_to FROM mpf.allocation_rules WHERE account_id = $1", [accountId]);
  expect(saved.rows).toEqual([{ effective_to: null }]);
});

test("contribution plan replacement preserves the retired plan's history", async () => {
  // testing data
  await database.query(
    `INSERT INTO mpf.contribution_plans (account_id, contribution_stream, amount, expected_day, effective_from)
     VALUES ($1, 'employee', 100, 10, '2026-09-01')`, [accountId]
  );
  const payload = { contribution_stream: "EMPLOYEE", amount: "200.12345678", expected_day: 15, effective_from: "2026-10-01" };

  // test
  const response = await request(app).put(`/v1/accounts/${accountId}/contribution-plans`).set("X-API-Key", apiKey).send(payload);
  const listed = await request(app).get(`/v1/accounts/${accountId}/contribution-plans`).set("X-API-Key", apiKey);

  // assert
  expect(response.status).toBe(200);
  expect(response.body.contribution_stream).toBe("employee");
  expect(listed.body.items).toHaveLength(2);
  const saved = await database.query("SELECT amount::text, active, effective_to::text FROM mpf.contribution_plans WHERE account_id = $1 ORDER BY effective_from", [accountId]);
  expect(saved.rows).toEqual([
    { amount: "100.00000000", active: false, effective_to: "2026-09-30" },
    { amount: "200.12345678", active: true, effective_to: null }
  ]);
});

test.each([0, -1])("nonpositive plan amount %s is rejected", async (amount) => {
  // test
  const response = await request(app).put(`/v1/accounts/${accountId}/contribution-plans`).set("X-API-Key", apiKey).send({
    contribution_stream: "employee", amount, expected_day: 15, effective_from: "2026-10-01"
  });

  // assert
  expect(response.status).toBe(400);
  const saved = await database.query("SELECT plan_id FROM mpf.contribution_plans WHERE account_id = $1", [accountId]);
  expect(saved.rows).toEqual([]);
});

test("reconciliation commits verified balances, its record, and the invalidation together", async () => {
  // testing data
  const payload = {
    effective_date: "2026-10-15", notes: "Statement verified",
    holdings: [{ fund_id: fundId, units: "12.5" }, { fund_id: secondFundId, units: "20" }]
  };

  // test
  const response = await request(app).post(`/v1/accounts/${accountId}/reconciliations`).set("X-API-Key", apiKey).send(payload);
  const listed = await request(app).get(`/v1/accounts/${accountId}/reconciliations`).set("X-API-Key", apiKey);

  // assert
  expect(response.status).toBe(200);
  expect(response.body.inserted_baselines).toBe(2);
  expect(listed.body.items[0]).toMatchObject({ notes: "Statement verified" });
  expect(listed.body.items[0].holdings).toHaveLength(2);
  const saved = await database.query("SELECT source, verification_status FROM mpf.holdings_baselines WHERE account_id = $1", [accountId]);
  expect(saved.rows).toEqual([
    { source: "reconciliation", verification_status: "VERIFIED" },
    { source: "reconciliation", verification_status: "VERIFIED" }
  ]);
  const invalidations = await database.query("SELECT reason FROM mpf.snapshot_invalidation_requests WHERE account_id = $1", [accountId]);
  expect(invalidations.rows).toEqual([{ reason: "reconciliation" }]);
});

test("failed reconciliation rolls back its record and every balance", async () => {
  // testing data
  const payload = {
    effective_date: "2026-10-15", notes: "Should roll back",
    holdings: [{ fund_id: fundId, units: "10" }, { fund_id: "missing-fund", units: "20" }]
  };

  // test
  const response = await request(app).post(`/v1/accounts/${accountId}/reconciliations`).set("X-API-Key", apiKey).send(payload);

  // assert
  expect(response.status).toBe(500);
  const records = await database.query("SELECT reconciliation_id FROM mpf.reconciliation_records WHERE account_id = $1", [accountId]);
  const holdings = await database.query("SELECT baseline_id FROM mpf.holdings_baselines WHERE account_id = $1", [accountId]);
  expect(records.rows).toEqual([]);
  expect(holdings.rows).toEqual([]);
});

test("fund lookup resolves IDs and searches aliases", async () => {
  // testing data
  const alias = `alias-${randomUUID()}`;
  await database.query("INSERT INTO mpf.fund_aliases (fund_id, alias, source) VALUES ($1, $2, 'test')", [fundId, alias]);

  // test
  const lookup = await request(app).get("/v1/funds").query({ ids: fundId }).set("X-API-Key", apiKey);
  const search = await request(app).get("/v1/funds").query({ search: alias }).set("X-API-Key", apiKey);

  // assert
  expect(lookup.status).toBe(200);
  expect(lookup.body.items[0]).toMatchObject({ fund_id: fundId, aliases: [alias] });
  expect(search.body.items).toHaveLength(1);
  expect(search.body.items[0].fund_id).toBe(fundId);
});
