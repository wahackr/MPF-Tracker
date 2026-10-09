import assert from "node:assert/strict";
import test from "node:test";

import { enqueueCrawlerJob, IdempotencyConflict } from "../../../dist/libs/jobs.js";

const saved = {
  job_id: "job-1", service: "crawler", job_type: "sync", status: "running",
  request: { provider: "all", rolling_days: 7 }
};

test("a retry returns the original job without changing its request or status", async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: calls.length === 1 ? [] : [saved] };
  };
  const result = await enqueueCrawlerJob(query, "sync", saved.request, "same-key");
  assert.equal(result.job_id, saved.job_id);
  assert.equal(result.status, "running");
  assert.match(calls[0].sql, /DO NOTHING/);
  assert.doesNotMatch(calls[0].sql, /DO UPDATE/);
});

test("a reused key with a different payload is rejected", async () => {
  let calls = 0;
  const query = async () => ({ rows: ++calls === 1 ? [] : [saved] });
  await assert.rejects(
    enqueueCrawlerJob(query, "sync", { provider: "hsbc", rolling_days: 7 }, "same-key"),
    IdempotencyConflict
  );
});

test("a new job is returned from the insert", async () => {
  let calls = 0;
  const query = async () => { calls += 1; return { rows: [{ ...saved, status: "queued" }] }; };
  const result = await enqueueCrawlerJob(query, "sync", saved.request, "new-key");
  assert.equal(result.status, "queued");
  assert.equal(calls, 1);
});
