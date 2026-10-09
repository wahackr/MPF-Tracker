import express, { NextFunction, Request, Response } from "express";
import { ZodError, z } from "zod";

import { requireApiKey } from "./auth.js";
import { healthCheck } from "./db.js";
import {
  confirmPurchaseEvent,
  listPurchaseEvents,
  listPurchaseTransactions,
  processPurchases
} from "./processor.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const ProcessSchema = z.object({
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  account_id: z.string().uuid().optional()
});

const ConfirmSchema = z.object({
  trade_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  transactions: z.array(
    z.object({
      fund_id: z.string().min(1),
      cash_amount: z.union([z.string(), z.number()]),
      unit_price: z.union([z.string(), z.number()]),
      units_delta: z.union([z.string(), z.number()]),
      trade_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    })
  ).min(1)
});

app.get("/health", async (_req, res) => {
  const ok = await healthCheck();
  if (ok) {
    res.json({ service: "purchase", status: "ready", database: "up" });
    return;
  }
  res.status(503).json({ service: "purchase", status: "not_ready", database: "down" });
});

app.use("/v1", requireApiKey);

app.post("/v1/purchases/process", async (req, res, next) => {
  try {
    const payload = ProcessSchema.parse(req.body ?? {});
    const result = await processPurchases(payload);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/purchases/events", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 500), 1), 5000);
    const items = await listPurchaseEvents(limit);
    res.json({ count: items.length, items });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/purchases/transactions", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 500), 1), 5000);
    const items = await listPurchaseTransactions(limit);
    res.json({ count: items.length, items });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/purchases/events/:eventId/confirm", async (req, res, next) => {
  try {
    const payload = ConfirmSchema.parse(req.body ?? {});
    const result = await confirmPurchaseEvent(req.params.eventId, payload);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ detail: "Invalid request payload", issues: error.issues });
    return;
  }
  const status = (error as Error & { status?: number }).status ?? 500;
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(status).json({ detail: message });
});

const port = Number(process.env.PORT ?? "8000");
app.listen(port, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`purchase listening on :${port}`);
});
