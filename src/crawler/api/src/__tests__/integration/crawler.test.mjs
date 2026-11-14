import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";

let database;
let app;
let enqueueCrawlerJob;
let IdempotencyConflict;
let closeDatabase;
let idempotencyKey;
let jobIds;
let fundId;
let secondFundId;
const apiKey = "crawler-test-key";

beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required for crawler API tests");

  // Fixture inserts use the admin connection; API operations use the actual crawler role.
  const url = new URL(connectionString);
  process.env.API_KEY = apiKey;
  process.env.DB_HOST = url.hostname;
  process.env.DB_PORT = url.port || "5432";
  process.env.DB_NAME = decodeURIComponent(url.pathname.slice(1));
  process.env.DB_USER = process.env.CRAWLER_DB_USER ?? "mpf_crawler";
  process.env.DB_PASSWORD = process.env.CRAWLER_DB_PASSWORD ?? "REPLACE_ME_CRAWLER_PASSWORD";

  database = new Client({ connectionString });
  await database.connect();
  ({ app } = await import("../../../dist/app.js"));
  ({ enqueueCrawlerJob, IdempotencyConflict } = await import("../../../dist/libs/jobs.js"));
  ({ closeDatabase } = await import("../../../dist/libs/db.js"));
});

beforeEach(async () => {
  // testing data
  idempotencyKey = `test-${randomUUID()}`;
  jobIds = [];
  fundId = `TEST:${randomUUID()}`;
  secondFundId = `TEST:${randomUUID()}`;

  await database.query(
    `INSERT INTO mpf.funds (fund_id, provider, provider_fund_code, name, currency)
     VALUES ($1, 'test', $1, 'First test fund', 'HKD'), ($2, 'test', $2, 'Second test fund', 'HKD')`,
    [fundId, secondFundId]
  );

  await database.query(
    `INSERT INTO mpf.fund_prices (fund_id, price_date, bid, offer, source, fetched_at)
     VALUES ($1, '2026-10-13', 10, 11, 'test', NOW()),
            ($1, '2026-10-14', 20, 21, 'test', NOW()),
            ($1, '2026-10-15', 30, 31, 'test', NOW())`, [fundId]
  );
});

afterEach(async () => {
  // Delete only this test's committed fixtures and jobs, including server-generated keys.
  await database.query(
    "DELETE FROM mpf.jobs WHERE idempotency_key = ANY($1::text[]) OR job_id = ANY($2::uuid[])",
    [[idempotencyKey, `${idempotencyKey}:other`], jobIds]
  );
  await database.query("DELETE FROM mpf.fund_prices WHERE fund_id = $1", [fundId]);
  await database.query("DELETE FROM mpf.funds WHERE fund_id = ANY($1::text[])", [[fundId, secondFundId]]);
});

afterAll(async () => {
  await closeDatabase?.();
  await database?.end();
});

test("enqueue returns the job ID and commits the exact request", async () => {
  // testing data
  const payload = { provider: "hsbc", rolling_days: 7 };

  // test
  const result = await enqueueCrawlerJob("sync", payload, idempotencyKey);

  // assert
  expect(result).toEqual({ job_id: expect.any(String), service: "crawler", job_type: "sync", status: "queued" });
  const saved = await database.query(
    "SELECT job_id, service, job_type, status, idempotency_key, request, attempts FROM mpf.jobs WHERE job_id = $1", [result.job_id]
  );
  expect(saved.rows).toEqual([{
    ...result, idempotency_key: idempotencyKey, request: payload, attempts: 0
  }]);
});

test("repeating a request with reordered nested object keys returns the original job", async () => {
  // testing data
  const payload = { provider: "hsbc", options: { enabled: true, nested: [{ a: 1, b: 2 }, null] } };
  const original = await enqueueCrawlerJob("sync", payload, idempotencyKey);
  const reordered = { options: { nested: [{ b: 2, a: 1 }, null], enabled: true }, provider: "hsbc" };

  // test
  const repeated = await enqueueCrawlerJob("sync", reordered, idempotencyKey);

  // assert
  expect(repeated).toEqual(original);
  const saved = await database.query("SELECT count(*)::int AS count FROM mpf.jobs WHERE idempotency_key = $1", [idempotencyKey]);
  expect(saved.rows[0].count).toBe(1);
});

test.each([
  ["backfill", { provider: "hsbc", funds: ["a", "b"] }],
  ["sync", { provider: "manulife", funds: ["a", "b"] }],
  ["sync", { provider: "hsbc", funds: ["b", "a"] }]
])("a conflicting %s request leaves the original job unchanged: %j", async (jobType, payload) => {
  // testing data
  const originalPayload = { provider: "hsbc", funds: ["a", "b"] };
  const original = await enqueueCrawlerJob("sync", originalPayload, idempotencyKey);

  // test
  const operation = enqueueCrawlerJob(jobType, payload, idempotencyKey);

  // assert
  await expect(operation).rejects.toBeInstanceOf(IdempotencyConflict);
  const saved = await database.query("SELECT job_id, job_type, request FROM mpf.jobs WHERE idempotency_key = $1", [idempotencyKey]);
  expect(saved.rows).toEqual([{ job_id: original.job_id, job_type: "sync", request: originalPayload }]);
});

test("concurrent identical requests commit exactly one job", async () => {
  // testing data
  const payload = { provider: "all", rolling_days: 7 };

  // test
  const [first, second] = await Promise.all([
    enqueueCrawlerJob("sync", payload, idempotencyKey),
    enqueueCrawlerJob("sync", payload, idempotencyKey)
  ]);

  // assert
  expect(second).toEqual(first);
  const saved = await database.query("SELECT count(*)::int AS count FROM mpf.jobs WHERE idempotency_key = $1", [idempotencyKey]);
  expect(saved.rows[0].count).toBe(1);
});

test("an idempotency key used by another service does not block crawler jobs", async () => {
  // testing data
  await database.query(
    "INSERT INTO mpf.jobs (service, job_type, status, idempotency_key, request) VALUES ('other', 'sync', 'queued', $1, '{}')", [idempotencyKey]
  );

  // test
  const result = await enqueueCrawlerJob("sync", { provider: "all" }, idempotencyKey);

  // assert
  expect(result.service).toBe("crawler");
  const saved = await database.query("SELECT service FROM mpf.jobs WHERE idempotency_key = $1 ORDER BY service", [idempotencyKey]);
  expect(saved.rows).toEqual([{ service: "crawler" }, { service: "other" }]);
});

test("health checks the database without authentication", async () => {
  // test
  const response = await request(app).get("/health");

  // assert
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ service: "crawler-api", status: "ready", database: "up" });
});

test.each([undefined, "wrong", "xxxxxxxxxxxxxxxx"])("job creation rejects API key %s", async (key) => {
  // testing data
  const httpRequest = request(app).post("/v1/crawl/jobs/sync").set("Idempotency-Key", idempotencyKey);
  if (key !== undefined) httpRequest.set("X-API-Key", key);

  // test
  const response = await httpRequest.send({});

  // assert
  expect(response.status).toBe(401);
  const saved = await database.query("SELECT job_id FROM mpf.jobs WHERE idempotency_key = $1", [idempotencyKey]);
  expect(saved.rows).toEqual([]);
});

test("sync HTTP requests commit default values and expose the job for retrieval", async () => {
  // test
  const created = await request(app).post("/v1/crawl/jobs/sync").set("X-API-Key", apiKey)
    .set("Idempotency-Key", idempotencyKey).send({});
  const fetched = await request(app).get(`/v1/crawl/jobs/${created.body.job_id}`).set("X-API-Key", apiKey);

  // assert
  expect(created.status).toBe(202);
  expect(created.body).toMatchObject({ service: "crawler", job_type: "sync", status: "queued" });
  expect(fetched.status).toBe(200);
  expect(fetched.body).toMatchObject({ job_id: created.body.job_id, request: { provider: "all", rolling_days: 7 }, attempts: 0 });
  const saved = await database.query("SELECT request FROM mpf.jobs WHERE job_id = $1", [created.body.job_id]);
  expect(saved.rows).toEqual([{ request: { provider: "all", rolling_days: 7 } }]);
});

test("HTTP idempotency conflicts return 409 and preserve the original request", async () => {
  // testing data
  await enqueueCrawlerJob("sync", { provider: "hsbc", rolling_days: 7 }, idempotencyKey);

  // test
  const response = await request(app).post("/v1/crawl/jobs/sync").set("X-API-Key", apiKey)
    .set("Idempotency-Key", idempotencyKey).send({ provider: "manulife" });

  // assert
  expect(response.status).toBe(409);
  expect(response.body.detail).toMatch(/already used/);
  const saved = await database.query("SELECT request FROM mpf.jobs WHERE idempotency_key = $1", [idempotencyKey]);
  expect(saved.rows).toEqual([{ request: { provider: "hsbc", rolling_days: 7 } }]);
});

test("requests without an idempotency header receive independent job IDs", async () => {
  // test
  const first = await request(app).post("/v1/crawl/jobs/sync").set("X-API-Key", apiKey).send({});
  if (first.body.job_id) jobIds.push(first.body.job_id);
  const second = await request(app).post("/v1/crawl/jobs/sync").set("X-API-Key", apiKey).send({});
  if (second.body.job_id) jobIds.push(second.body.job_id);

  // assert
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(first.body.job_id).not.toBe(second.body.job_id);
  const saved = await database.query("SELECT job_id FROM mpf.jobs WHERE job_id = ANY($1::uuid[])", [jobIds]);
  expect(saved.rows).toHaveLength(2);
});

test("backfill HTTP requests commit the date range and default provider", async () => {
  // testing data
  const payload = { from_date: "2026-10-01", to_date: "2026-10-15" };

  // test
  const response = await request(app).post("/v1/crawl/jobs/backfill").set("X-API-Key", apiKey)
    .set("Idempotency-Key", idempotencyKey).send(payload);

  // assert
  expect(response.status).toBe(202);
  expect(response.body.job_type).toBe("backfill");
  const saved = await database.query("SELECT request FROM mpf.jobs WHERE job_id = $1", [response.body.job_id]);
  expect(saved.rows).toEqual([{ request: { ...payload, provider: "all" } }]);
});

test.each([
  ["sync", { provider: "invalid" }],
  ["sync", { rolling_days: 0 }],
  ["sync", { rolling_days: 29 }],
  ["sync", { rolling_days: 1.5 }],
  ["backfill", { from_date: "invalid", to_date: "2026-10-15" }],
  ["backfill", { from_date: "2026-10-20", to_date: "2026-10-15" }]
])("invalid %s payload creates no job: %j", async (jobType, payload) => {
  // test
  const response = await request(app).post(`/v1/crawl/jobs/${jobType}`).set("X-API-Key", apiKey)
    .set("Idempotency-Key", idempotencyKey).send(payload);

  // assert
  expect(response.status).toBe(400);
  const saved = await database.query("SELECT job_id FROM mpf.jobs WHERE idempotency_key = $1", [idempotencyKey]);
  expect(saved.rows).toEqual([]);
});

test("job reads return persisted completion status and worker results", async () => {
  // testing data
  const job = await enqueueCrawlerJob("sync", { provider: "all", rolling_days: 7 }, idempotencyKey);
  await database.query("UPDATE mpf.jobs SET status = 'succeeded', result = '{\"prices\":3}', attempts = 1 WHERE job_id = $1", [job.job_id]);

  // test
  const response = await request(app).get(`/v1/crawl/jobs/${job.job_id}`).set("X-API-Key", apiKey);
  const repeated = await enqueueCrawlerJob("sync", { provider: "all", rolling_days: 7 }, idempotencyKey);

  // assert
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ status: "succeeded", result: { prices: 3 }, attempts: 1 });
  expect(repeated).toEqual({ ...job, status: "succeeded" });
});

test("missing jobs and jobs belonging to other services return 404", async () => {
  // testing data
  const otherJobId = randomUUID();
  await database.query(
    "INSERT INTO mpf.jobs (job_id, service, job_type, status, idempotency_key) VALUES ($1, 'other', 'sync', 'queued', $2)", [otherJobId, idempotencyKey]
  );

  // test
  const missing = await request(app).get(`/v1/crawl/jobs/${randomUUID()}`).set("X-API-Key", apiKey);
  const other = await request(app).get(`/v1/crawl/jobs/${otherJobId}`).set("X-API-Key", apiKey);

  // assert
  expect(missing.status).toBe(404);
  expect(other.status).toBe(404);
});

test("fund listing returns persisted metadata and honors the requested limit", async () => {
  // test
  const response = await request(app).get("/v1/funds").set("X-API-Key", apiKey);
  const limited = await request(app).get("/v1/funds").query({ limit: 1 }).set("X-API-Key", apiKey);

  // assert
  expect(response.status).toBe(200);
  expect(response.body.count).toBe(2);
  expect(response.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ fund_id: fundId, provider: "test", currency: "HKD" })]));
  expect(limited.body.count).toBe(1);
});

test("price reads filter dates inclusively and return newest prices first", async () => {
  // test
  const response = await request(app).get(`/v1/funds/${encodeURIComponent(fundId)}/prices`).set("X-API-Key", apiKey)
    .query({ from_date: "2026-10-14", to_date: "2026-10-15", limit: 2 });

  // assert
  expect(response.status).toBe(200);
  expect(response.body.fund_id).toBe(fundId);
  expect(response.body.count).toBe(2);
  expect(response.body.items.map((price) => price.bid)).toEqual(["30.0000000000", "20.0000000000"]);
});

test.each(["invalid", "0", "99999", "1.5"])("fund limit %s uses the documented bounds", async (limit) => {
  // test
  const response = await request(app).get("/v1/funds").query({ limit }).set("X-API-Key", apiKey);

  // assert
  expect(response.status).toBe(200);
  expect(response.body.count).toBe(limit === "1.5" ? 1 : 2);
});
