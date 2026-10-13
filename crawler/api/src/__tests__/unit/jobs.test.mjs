import assert from "node:assert/strict";
import test from "node:test";

import { IdempotencyConflict } from "../../../dist/libs/jobs.js";

test("idempotency conflicts expose the API error message", () => {
  const error = new IdempotencyConflict();
  assert.equal(
    error.message,
    "Idempotency-Key is already used for a different crawler request"
  );
});
