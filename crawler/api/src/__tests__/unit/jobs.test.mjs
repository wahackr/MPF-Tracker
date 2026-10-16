import { expect, test } from "@jest/globals";
import { IdempotencyConflict } from "../../../dist/libs/jobs.js";

test("idempotency conflicts expose the API error message", () => {
  // test
  const error = new IdempotencyConflict();

  // assert
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe("Idempotency-Key is already used for a different crawler request");
});
