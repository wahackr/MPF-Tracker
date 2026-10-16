import { beforeEach, expect, jest, test } from "@jest/globals";
import request from "supertest";

// testing data
const account = "00000000-0000-4000-8000-000000000001";
const confirm = { trade_date: "2026-10-15", transactions: [{ fund_id: "fund", cash_amount: "100", unit_price: "10", units_delta: "10" }] };

process.env.API_KEY = "purchase-test-key";

// mock
const healthCheck = jest.fn();
const processPurchases = jest.fn();
const confirmPurchaseEvent = jest.fn();
const listPurchaseEvents = jest.fn();
const listPurchaseTransactions = jest.fn();
jest.unstable_mockModule("../../../dist/libs/db.js", () => ({ healthCheck }));
jest.unstable_mockModule("../../../dist/main.js", () => ({ processPurchases, confirmPurchaseEvent, listPurchaseEvents, listPurchaseTransactions }));
const { app } = await import("../../../dist/app.js");
beforeEach(() => {
  // mock
  jest.resetAllMocks();
});

test.each([true, false])("health reports database readiness %s without API authentication", async (ready) => {
  // mock
  healthCheck.mockResolvedValueOnce(ready);

  // test
  const response = await request(app).get("/health");

  // assert
  expect(response.status).toBe(ready ? 200 : 503);
  expect(response.body.database).toBe(ready ? "up" : "down");
});

test.each([undefined, "wrong", "xxxxxxxxxxxxxxxxx"])("rejects missing or incorrect API key %s", async (key) => {
  // testing data
  const req = request(app).post("/v1/purchases/process");
  if (key !== undefined) req.set("X-API-Key", key);

  // test
  const response = await req.send({});

  // assert
  expect(response.status).toBe(401);
  expect(processPurchases).not.toHaveBeenCalled();
});

test("process validates and forwards its payload", async () => {
  // mock
  processPurchases.mockResolvedValueOnce({ processed_events: 1 });

  // test
  const response = await request(app).post("/v1/purchases/process").set("X-API-Key", process.env.API_KEY)
    .send({ as_of_date: "2026-10-15", account_id: account });

  // assert
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ processed_events: 1 });
  expect(processPurchases).toHaveBeenCalledWith({ as_of_date: "2026-10-15", account_id: account });
});

test.each([{ as_of_date: "invalid" }, { account_id: "invalid" }])("invalid process payload returns 400: %j", async (payload) => {
  // test
  const response = await request(app).post("/v1/purchases/process").set("X-API-Key", process.env.API_KEY).send(payload);

  // assert
  expect(response.status).toBe(400);
  expect(processPurchases).not.toHaveBeenCalled();
});

test("confirm forwards event and all transactions", async () => {
  // mock
  confirmPurchaseEvent.mockResolvedValueOnce({ confirmed_transactions: 1 });

  // test
  const response = await request(app).post(`/v1/purchases/events/${account}/confirm`).set("X-API-Key", process.env.API_KEY).send(confirm);

  // assert
  expect(response.status).toBe(200);
  expect(confirmPurchaseEvent).toHaveBeenCalledWith(account, confirm);
});

test("empty confirmation transactions return 400", async () => {
  // test
  const response = await request(app).post(`/v1/purchases/events/${account}/confirm`).set("X-API-Key", process.env.API_KEY).send({ ...confirm, transactions: [] });

  // assert
  expect(response.status).toBe(400);
  expect(confirmPurchaseEvent).not.toHaveBeenCalled();
});

test.each([["events", listPurchaseEvents], ["transactions", listPurchaseTransactions]])("list %s forwards bounded limits", async (path, list) => {
  // testing data
  const limits = [["", 500], ["?limit=0", 1], ["?limit=9000", 5000]];

  for (const [input, expected] of limits) {
    // mock
    list.mockResolvedValueOnce([{ saved: true }]);

    // test
    const response = await request(app).get(`/v1/purchases/${path}${input}`).set("X-API-Key", process.env.API_KEY);

    // assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 1, items: [{ saved: true }] });
    expect(list).toHaveBeenLastCalledWith(expected);
  }
});

test.each([404, 500])("operation errors return status %s", async (status) => {
  // testing data
  const error = new Error("operation failed");
  if (status === 404) error.status = 404;

  // mock
  confirmPurchaseEvent.mockRejectedValueOnce(error);

  // test
  const response = await request(app).post(`/v1/purchases/events/${account}/confirm`).set("X-API-Key", process.env.API_KEY).send(confirm);

  // assert
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ detail: "operation failed" });
});
