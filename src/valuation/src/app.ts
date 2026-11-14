import express, { NextFunction, Request, Response } from "express";
import { ZodError, z } from "zod";

import { requireApiKey } from "./libs/auth.js";
import { calculatePortfolioAsOf } from "./main.js";
import {
  applyPendingInvalidations,
  listSnapshotDatesInRange,
  listStaleSnapshotDates,
  persistSnapshot,
  snapshotHistory
} from "./libs/repository.js";
import { healthCheck } from "./libs/db.js";
import { hkToday } from "./libs/rules.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SnapshotSchema = z.object({
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  account_id: z.string().uuid().optional()
});

const RebuildSchema = z.object({
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  account_id: z.string().uuid().optional()
});

app.get("/health", async (_req, res) => {
  const ok = await healthCheck();
  if (ok) {
    res.json({ service: "valuation", status: "ready", database: "up" });
    return;
  }
  res.status(503).json({ service: "valuation", status: "not_ready", database: "down" });
});

app.use("/v1", requireApiKey);

app.post("/v1/valuation/snapshot", async (req, res, next) => {
  try {
    const payload = SnapshotSchema.parse(req.body ?? {});
    const asOfDate = payload.as_of_date ?? hkToday();
    await applyPendingInvalidations(payload.account_id);
    const calculation = await calculatePortfolioAsOf(asOfDate, payload.account_id, true);
    const persisted = await persistSnapshot(calculation);
    res.json({
      requested_as_of: calculation.requested_as_of,
      saved_accounts: persisted.saved_accounts,
      calculation_status: calculation.calculation_status,
      unpriced_fund_count: calculation.unpriced_fund_count
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/valuation/rebuild", async (req, res, next) => {
  try {
    const payload = RebuildSchema.parse(req.body ?? {});
    const invalidationsApplied = await applyPendingInvalidations(payload.account_id);
    const dates = payload.from_date || payload.to_date
      ? await listSnapshotDatesInRange(payload.from_date, payload.to_date, payload.account_id)
      : await listStaleSnapshotDates(payload.account_id);

    let rebuilt = 0;
    for (const asOfDate of dates) {
      const calculation = await calculatePortfolioAsOf(asOfDate, payload.account_id, true);
      await persistSnapshot(calculation);
      rebuilt += 1;
    }
    res.json({
      rebuilt_dates: dates,
      rebuilt_count: rebuilt,
      invalidations_applied: invalidationsApplied
    });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/valuation/latest", async (req, res, next) => {
  try {
    const accountId = typeof req.query.account_id === "string" ? req.query.account_id : undefined;
    const includeEstimated = req.query.include_estimated !== "false";
    const asOfDate = hkToday();
    const calculation = await calculatePortfolioAsOf(asOfDate, accountId, includeEstimated);
    res.json(calculation);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/valuation/as-of", async (req, res, next) => {
  try {
    const asOfDate = typeof req.query.date === "string" ? req.query.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      res.status(400).json({ detail: "date query parameter must be YYYY-MM-DD" });
      return;
    }
    const accountId = typeof req.query.account_id === "string" ? req.query.account_id : undefined;
    const includeEstimated = req.query.include_estimated !== "false";
    const calculation = await calculatePortfolioAsOf(asOfDate, accountId, includeEstimated);
    res.json(calculation);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/valuation/history", async (req, res, next) => {
  try {
    const fromDate = typeof req.query.from_date === "string" ? req.query.from_date : undefined;
    const toDate = typeof req.query.to_date === "string" ? req.query.to_date : undefined;
    const accountId = typeof req.query.account_id === "string" ? req.query.account_id : undefined;
    const items = await snapshotHistory(fromDate, toDate, accountId);
    res.json({ count: items.length, items });
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

export { app };
