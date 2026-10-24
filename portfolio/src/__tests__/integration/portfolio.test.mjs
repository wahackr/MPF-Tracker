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
let fixtureFundIds;
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
  fixtureFundIds = [fundId, secondFundId];

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
  await database.query("DELETE FROM mpf.funds WHERE fund_id = ANY($1::text[])", [fixtureFundIds]);
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

async function switchBaseline(units = '100') {
  await database.query(`INSERT INTO mpf.holdings_baselines
    (account_id, fund_id, effective_date, units, source, verification_status)
    VALUES ($1, $2, '2026-10-01', $3, 'statement', 'VERIFIED')`, [accountId, fundId, units]);
}
function switchPayload(extra = {}) {
  return { switch_id: randomUUID(), trade_date: '2026-10-10', from_fund_id: fundId,
    to_fund_id: secondFundId, units_sold: '40.0000000001', units_bought: '25.1234567890', notes: 'Statement', ...extra };
}
function recordSwitch(payload) {
  return request(app).post(`/v1/accounts/${accountId}/switches`).set('X-API-Key', apiKey).send(payload);
}

test('completed switches commit exact units, history and invalidation without creating contributions', async () => {
  await switchBaseline();
  const payload = switchPayload();
  const response = await recordSwitch(payload);
  expect(response.status).toBe(201);
  const listed = await request(app).get(`/v1/accounts/${accountId}/switches`).set('X-API-Key', apiKey);
  expect(listed.body.items).toHaveLength(1);
  expect(listed.body.items[0]).toMatchObject({ switch_id: payload.switch_id,
    trade_date: payload.trade_date, notes: payload.notes,
    sales: [{ fund_id: fundId, units: '40.0000000001' }],
    purchases: [{ fund_id: secondFundId, units: '25.1234567890' }] });
  const invalidations = await database.query('SELECT reason, from_date::text FROM mpf.snapshot_invalidation_requests WHERE account_id=$1', [accountId]);
  expect(invalidations.rows).toEqual([{ reason: 'fund_switch', from_date: '2026-10-10' }]);
  const baselines = await database.query('SELECT * FROM mpf.holdings_baselines WHERE account_id=$1', [accountId]);
  expect(baselines.rows).toHaveLength(1);
});

test('concurrent identical switch submissions debit units only once', async () => {
  await switchBaseline();
  const payload = switchPayload();
  const results = await Promise.all([recordSwitch(payload), recordSwitch(payload)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
  expect((await database.query('SELECT * FROM mpf.fund_switches WHERE account_id=$1', [accountId])).rows).toHaveLength(1);
  expect((await recordSwitch({ ...payload, units_bought: '26' })).status).toBe(409);
});

test('concurrent distinct switches cannot spend the same units twice', async () => {
  await switchBaseline('60');
  const results = await Promise.all([recordSwitch(switchPayload()), recordSwitch(switchPayload())]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
  expect((await database.query('SELECT * FROM mpf.snapshot_invalidation_requests WHERE account_id=$1', [accountId])).rows).toHaveLength(1);
});

test('switches into a new fund can subsequently be switched back', async () => {
  await switchBaseline();
  expect((await recordSwitch(switchPayload())).status).toBe(201);
  expect((await recordSwitch(switchPayload({ trade_date: '2026-10-11', from_fund_id: secondFundId,
    to_fund_id: fundId, units_sold: '25.1234567890', units_bought: '40' }))).status).toBe(201);
});

test('a backdated switch cannot make a later switch oversell', async () => {
  await switchBaseline();
  expect((await recordSwitch(switchPayload({ trade_date: '2026-10-12', units_sold: '80' }))).status).toBe(201);
  expect((await recordSwitch(switchPayload())).status).toBe(400);
  expect((await database.query('SELECT * FROM mpf.fund_switches WHERE account_id=$1', [accountId])).rows).toHaveLength(1);
});

test.each([
  { units_sold: '0' }, { units_bought: '-1' }, { units_sold: 'NaN' },
  { units_sold: '0.00000000001' }, { trade_date: '2026-02-30' },
  { to_fund_id: 'same' }, { to_fund_id: 'missing' }
])('invalid switches save nothing: %j', async (extra) => {
  await switchBaseline();
  if (extra.to_fund_id === 'same') extra = { to_fund_id: fundId };
  expect((await recordSwitch(switchPayload(extra))).status).toBe(400);
  expect((await database.query('SELECT * FROM mpf.fund_switches WHERE account_id=$1', [accountId])).rows).toHaveLength(0);
});

test('switches reject another provider and same-day baselines', async () => {
  await switchBaseline();
  await database.query("UPDATE mpf.funds SET provider='other' WHERE fund_id=$1", [secondFundId]);
  expect((await recordSwitch(switchPayload())).status).toBe(400);
  await database.query("UPDATE mpf.funds SET provider='test' WHERE fund_id=$1", [secondFundId]);
  expect((await recordSwitch(switchPayload({ trade_date: '2026-10-01' }))).status).toBe(409);
});

async function groupedPayload() {
  const destinations = [randomUUID(), randomUUID()].map((id) => `TEST:${id}`);
  fixtureFundIds.push(...destinations);
  await database.query(`INSERT INTO mpf.funds (fund_id, provider, provider_fund_code, name, currency)
    SELECT id, 'test', id, 'Destination', 'HKD' FROM unnest($1::text[]) id`, [destinations]);
  await switchBaseline();
  await database.query(`INSERT INTO mpf.holdings_baselines
    (account_id, fund_id, effective_date, units, source, verification_status)
    VALUES ($1, $2, '2026-10-01', 200, 'statement', 'VERIFIED')`, [accountId, secondFundId]);
  return { switch_id: randomUUID(), trade_date: '2026-10-10',
    sales: [{ fund_id: fundId, units: '40' }, { fund_id: secondFundId, units: '50' }],
    purchases: [{ fund_id: destinations[0], units: '20' }, { fund_id: destinations[1], units: '30.1234567890' }] };
}

test('a two-to-two switch saves one operation with four exact legs and one invalidation', async () => {
  const payload = await groupedPayload();
  expect((await recordSwitch(payload)).status).toBe(201);
  const listed = await request(app).get(`/v1/accounts/${accountId}/switches`).set('X-API-Key', apiKey);
  expect(listed.body.items).toHaveLength(1);
  expect(listed.body.items[0].sales).toHaveLength(2);
  expect(listed.body.items[0].purchases).toHaveLength(2);
  expect(listed.body.items[0].purchases).toContainEqual({ fund_id: payload.purchases[1].fund_id, units: '30.1234567890' });
  const retry = { ...payload, sales: [...payload.sales].reverse(), purchases: [...payload.purchases].reverse() };
  expect((await recordSwitch(retry)).status).toBe(200);
  expect((await database.query('SELECT * FROM mpf.fund_switch_legs WHERE switch_id=$1', [payload.switch_id])).rows).toHaveLength(4);
  expect((await database.query('SELECT * FROM mpf.snapshot_invalidation_requests WHERE account_id=$1', [accountId])).rows).toHaveLength(1);
});

test('insufficient units in any selling fund rolls back every switch leg', async () => {
  const payload = await groupedPayload();
  payload.sales[1].units = '201';
  expect((await recordSwitch(payload)).status).toBe(400);
  expect((await database.query('SELECT * FROM mpf.fund_switches WHERE switch_id=$1', [payload.switch_id])).rows).toHaveLength(0);
  expect((await database.query('SELECT * FROM mpf.fund_switch_legs WHERE switch_id=$1', [payload.switch_id])).rows).toHaveLength(0);
  expect((await database.query('SELECT * FROM mpf.snapshot_invalidation_requests WHERE account_id=$1', [accountId])).rows).toHaveLength(0);
});

test.each(['empty_sales', 'empty_purchases', 'duplicate_sale', 'duplicate_purchase', 'overlap'])(
  'grouped switch rejects %s before persisting', async (invalid) => {
    const payload = await groupedPayload();
    if (invalid === 'empty_sales') payload.sales = [];
    if (invalid === 'empty_purchases') payload.purchases = [];
    if (invalid === 'duplicate_sale') payload.sales.push(payload.sales[0]);
    if (invalid === 'duplicate_purchase') payload.purchases.push(payload.purchases[0]);
    if (invalid === 'overlap') payload.purchases[0].fund_id = payload.sales[0].fund_id;
    expect((await recordSwitch(payload)).status).toBe(400);
    expect((await database.query('SELECT * FROM mpf.fund_switches WHERE switch_id=$1', [payload.switch_id])).rows).toHaveLength(0);
  }
);

test('migration preserves old one-to-one switches and is safe to reapply', async () => {
  const { readFileSync } = await import('node:fs');
  const switchId = randomUUID();
  await database.query(`INSERT INTO mpf.fund_switches
    (switch_id, account_id, trade_date, from_fund_id, to_fund_id, units_sold, units_bought)
    VALUES ($1, $2, '2026-10-10', $3, $4, 10, 5)`, [switchId, accountId, fundId, secondFundId]);
  let sql = readFileSync(new URL('../../../../migrations/sql/003_switch_legs.sql', import.meta.url), 'utf8');
  for (const service of ['CRAWLER', 'PORTFOLIO', 'PURCHASE', 'VALUATION']) {
    const name = process.env[`${service}_DB_USER`] ?? `mpf_${service.toLowerCase()}`;
    sql = sql.replaceAll(`{{${service}_DB_USER}}`, '"' + name.replaceAll('"', '""') + '"');
  }
  await database.query(sql);
  await database.query(sql);
  expect((await database.query('SELECT side, units::text FROM mpf.fund_switch_legs WHERE switch_id=$1 ORDER BY side', [switchId])).rows)
    .toEqual([{ side: 'BOUGHT', units: '5.0000000000' }, { side: 'SOLD', units: '10.0000000000' }]);
  expect((await database.query('SELECT units_sold::text FROM mpf.fund_switches WHERE switch_id=$1', [switchId])).rows[0].units_sold).toBe('10.0000000000');
});
