import assert from "node:assert/strict";
import test from "node:test";

import { findPriceForEstimation, loadPlansEffectiveOn, upsertContributionEvent } from "../../../dist/libs/repository.js";

test("historical processing includes plans retired by a later version", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ plan_id: "old-plan", active: false }] };
    }
  };

  const plans = await loadPlansEffectiveOn(client, "2026-09-10", "account-1");
  assert.deepEqual(plans, [{ plan_id: "old-plan", active: false }]);
  assert.deepEqual(calls[0].params, ["2026-09-10", "account-1"]);
  assert.match(calls[0].sql, /effective_from <= \$1::date/);
  assert.match(calls[0].sql, /effective_to IS NULL OR effective_to >= \$1::date/);
  assert.doesNotMatch(calls[0].sql, /active\s*=\s*TRUE/);
});

test("reprocessing preserves an existing confirmed contribution event", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: calls.length === 1 ? [] : [{ event_id: "event-1", status: "CONFIRMED" }] };
    }
  };
  const event = await upsertContributionEvent(client, "plan-1", "2026-10-01", "2026-10-10", "500");
  assert.deepEqual(event, { event_id: "event-1", status: "CONFIRMED" });
  assert.match(calls[0].sql, /DO NOTHING/);
  assert.doesNotMatch(calls[0].sql, /DO UPDATE/);
});

test("price lookup is bounded by the requested as-of date", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ price_date: "2026-10-05", price: "1.25" }] };
    }
  };
  const price = await findPriceForEstimation(client, "fund-1", "2026-10-01", 14, "2026-10-05");
  assert.equal(price.price, "1.25");
  assert.deepEqual(calls[0].params, ["fund-1", "2026-10-01", 14, "2026-10-05"]);
  assert.match(calls[0].sql, /fp\.price_date <= \$4::date/);
  assert.match(calls[0].sql, /fp\.bid AS price/);
  assert.doesNotMatch(calls[0].sql, /f\.provider/);
});
