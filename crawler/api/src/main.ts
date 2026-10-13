import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { query, withTransaction } from "./libs/db.js";
import { enqueueCrawlerJob } from "./libs/jobs.js";

const ProviderSchema = z.enum(["all", "hsbc", "manulife"]);

const SyncSchema = z.object({
  provider: ProviderSchema.default("all"),
  rolling_days: z.number().int().min(1).max(28).default(7)
});

const BackfillSchema = z.object({
  provider: ProviderSchema.default("all"),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  manulife_filter_days: z.number().int().min(1).max(90).optional()
});

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function crawlerRouter(): Router {
  const router = Router();

  router.post("/crawl/jobs/sync", async (req, res, next) => {
    try {
      const payload = SyncSchema.parse(req.body ?? {});
      const idempotencyKey = req.header("Idempotency-Key") ?? randomUUID();
      const result = await withTransaction((client) =>
        enqueueCrawlerJob((sql, params) => client.query(sql, params), "sync", payload, idempotencyKey)
      );
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/crawl/jobs/backfill", async (req, res, next) => {
    try {
      const payload = BackfillSchema.parse(req.body ?? {});
      const fromDate = new Date(payload.from_date);
      const toDate = new Date(payload.to_date);
      if (fromDate > toDate) {
        res.status(400).json({ detail: "from_date must be <= to_date" });
        return;
      }
      const idempotencyKey = req.header("Idempotency-Key") ?? randomUUID();
      const result = await withTransaction((client) =>
        enqueueCrawlerJob((sql, params) => client.query(sql, params), "backfill", payload, idempotencyKey)
      );
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/crawl/jobs/:jobId", async (req, res, next) => {
    try {
      const row = await query(
        `
        SELECT job_id, service, job_type, status, idempotency_key, request, result, attempts, error_message,
               created_at, updated_at
        FROM mpf.jobs
        WHERE service = 'crawler' AND job_id = $1::uuid
        `,
        [req.params.jobId]
      );
      if (row.rows.length === 0) {
        res.status(404).json({ detail: "Job not found" });
        return;
      }
      res.json(row.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  router.get("/funds", async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit, 200, 1000);
      const rows = await query(
        `
        SELECT fund_id, provider, provider_fund_code, name, currency, last_seen_at
        FROM mpf.funds
        ORDER BY provider, fund_id
        LIMIT $1
        `,
        [limit]
      );
      res.json({ count: rows.rows.length, items: rows.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/funds/:fundId/prices", async (req, res, next) => {
    try {
      const limit = parseLimit(req.query.limit, 500, 5000);
      const fromDate = typeof req.query.from_date === "string" ? req.query.from_date : null;
      const toDate = typeof req.query.to_date === "string" ? req.query.to_date : null;
      const rows = await query(
        `
        SELECT fund_id, price_date, bid, offer, price, source, fetched_at, updated_at
        FROM mpf.fund_prices
        WHERE fund_id = $1
          AND ($2::date IS NULL OR price_date >= $2::date)
          AND ($3::date IS NULL OR price_date <= $3::date)
        ORDER BY price_date DESC
        LIMIT $4
        `,
        [req.params.fundId, fromDate, toDate, limit]
      );
      res.json({ fund_id: req.params.fundId, count: rows.rows.length, items: rows.rows });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
