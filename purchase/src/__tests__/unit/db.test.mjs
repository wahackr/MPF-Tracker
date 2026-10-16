import { beforeEach, expect, jest, test } from "@jest/globals";

// mock
const client = { query: jest.fn(), release: jest.fn() };
const pool = { connect: jest.fn(), query: jest.fn(), end: jest.fn() };

jest.unstable_mockModule("pg", () => ({
  Pool: jest.fn(function() { return pool; })
}));

const { withTransaction, query, healthCheck, closeDatabase } = await import("../../../dist/libs/db.js");

beforeEach(() => {
  // mock
  jest.resetAllMocks();
  pool.connect.mockResolvedValue(client);
  client.query.mockResolvedValue({ rows: [] });
});

test("commits and releases a successful transaction", async () => {
  // testing data
  let receivedClient;
  const work = async (connection) => {
    receivedClient = connection;
    await connection.query("work");
    return 42;
  };

  // test
  const result = await withTransaction(work);

  // assert
  expect(receivedClient).toBe(client);
  expect(result).toBe(42);
  expect(client.query.mock.calls).toEqual([["BEGIN"], ["work"], ["COMMIT"]]);
  expect(client.release).toHaveBeenCalledTimes(1);
});

test("rolls back failed work and releases the client", async () => {
  // testing data
  const failure = new Error("failed write");
  const work = async () => { throw failure; };

  // test
  const operation = withTransaction(work);

  // assert
  await expect(operation).rejects.toBe(failure);
  expect(client.query.mock.calls).toEqual([["BEGIN"], ["ROLLBACK"]]);
  expect(client.release).toHaveBeenCalledTimes(1);
});

test("failed commit rolls back and releases", async () => {
  // mock
  client.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("commit failed"));

  // test
  const operation = withTransaction(async () => 42);

  // assert
  await expect(operation).rejects.toThrow("commit failed");
  expect(client.query.mock.calls).toEqual([["BEGIN"], ["COMMIT"], ["ROLLBACK"]]);
  expect(client.release).toHaveBeenCalledTimes(1);
});

test("connection failure propagates without running work", async () => {
  // mock
  const work = jest.fn();
  pool.connect.mockRejectedValueOnce(new Error("offline"));

  // test
  const operation = withTransaction(work);

  // assert
  await expect(operation).rejects.toThrow("offline");
  expect(work).not.toHaveBeenCalled();
});

test("query forwards SQL, parameters and results", async () => {
  // testing data
  const rows = [{ value: 1 }];

  // mock
  pool.query.mockResolvedValueOnce({ rows });

  // test
  const result = await query("SELECT $1", [1]);
  await query("SELECT 1");

  // assert
  expect(result).toEqual({ rows });
  expect(pool.query).toHaveBeenNthCalledWith(1, "SELECT $1", [1]);
  expect(pool.query).toHaveBeenNthCalledWith(2, "SELECT 1", []);
});

test("health check reflects database availability", async () => {
  // mock
  pool.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("offline"));

  // test
  const available = await healthCheck();
  const unavailable = await healthCheck();

  // assert
  expect(available).toBe(true);
  expect(unavailable).toBe(false);
});

test("shutdown closes the connection pool", async () => {
  // test
  await closeDatabase();

  // assert
  expect(pool.end).toHaveBeenCalledTimes(1);
});
