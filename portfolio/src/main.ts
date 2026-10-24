import { Router } from "express";
import { query } from "./libs/db.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerHoldingsRoutes } from "./routes/holdings.js";
import { registerAllocationsRoutes } from "./routes/allocations.js";
import { registerPlansRoutes } from "./routes/plans.js";
import { registerReconciliationsRoutes } from "./routes/reconciliations.js";
import { registerSwitchesRoutes } from "./routes/switches.js";

export function portfolioRouter(): Router {
  const router = Router();
  /**
   * GET /v1/funds
   * Resolves fund IDs for display or searches funds for the dashboard picker.
   * Query parameters: ids (optional comma-separated fund IDs, maximum 100) or
   * search (optional name, ID, provider code, or alias fragment; minimum two
   * characters). When ids is supplied, it takes precedence over search.
   */
  router.get("/funds", async (req, res, next) => {
    try {
      const fundIds = typeof req.query.ids === "string"
        ? req.query.ids.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 100)
        : [];
      if (fundIds.length > 0) {
        const result = await query(
          `
          SELECT
            f.fund_id,
            f.provider,
            f.provider_fund_code,
            f.name,
            COALESCE(array_agg(DISTINCT fa.alias) FILTER (WHERE fa.alias IS NOT NULL), ARRAY[]::text[]) AS aliases
          FROM mpf.funds f
          LEFT JOIN mpf.fund_aliases fa ON fa.fund_id = f.fund_id
          WHERE f.fund_id = ANY($1::text[])
          GROUP BY f.fund_id
          `,
          [fundIds]
        );
        res.json({ count: result.rows.length, items: result.rows });
        return;
      }
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      if (search.length < 2) {
        res.json({ count: 0, items: [] });
        return;
      }
      const pattern = `%${search}%`;
      const result = await query(
        `
        SELECT
          f.fund_id,
          f.provider,
          f.provider_fund_code,
          f.name,
          COALESCE(array_agg(DISTINCT fa.alias) FILTER (WHERE fa.alias IS NOT NULL), ARRAY[]::text[]) AS aliases
        FROM mpf.funds f
        LEFT JOIN mpf.fund_aliases fa ON fa.fund_id = f.fund_id
        WHERE f.name ILIKE $1
          OR f.fund_id ILIKE $1
          OR f.provider_fund_code ILIKE $1
          OR fa.alias ILIKE $1
        GROUP BY f.fund_id
        ORDER BY
          CASE WHEN f.name ILIKE $2 THEN 0 WHEN bool_or(fa.alias ILIKE $2) THEN 1 ELSE 2 END,
          f.provider, f.name
        LIMIT 20
        `,
        [pattern, `${search}%`]
      );
      res.json({ count: result.rows.length, items: result.rows });
    } catch (error) {
      next(error);
    }
  });
  registerAccountsRoutes(router);
  registerHoldingsRoutes(router);
  registerAllocationsRoutes(router);
  registerPlansRoutes(router);
  registerReconciliationsRoutes(router);
  registerSwitchesRoutes(router);
  /**
   * GET /v1/valuation/latest
   * Proxies the latest on-demand valuation from the Valuation API for display
   * in the portfolio dashboard. Query parameter: account_id (required UUID).
   */
  router.get("/valuation/latest", async (req, res, next) => {
    try {
      const accountId = typeof req.query.account_id === "string" ? req.query.account_id : "";
      if (!accountId) {
        res.status(400).json({ detail: "account_id query parameter is required" });
        return;
      }

      const valuationUrl = new URL("/v1/valuation/latest", process.env.VALUATION_API_URL ?? "http://mpf-valuation:8000");
      valuationUrl.searchParams.set("account_id", accountId);
      const response = await fetch(valuationUrl, {
        headers: { "X-API-Key": req.header("X-API-Key") ?? "" }
      });
      const payload = await response.json().catch(() => ({}));
      res.status(response.status).json(payload);
    } catch (error) {
      next(error);
    }
  });
  /**
   * GET /v1/valuation/history
   * Proxies saved valuation snapshots from the Valuation API. Query parameters:
   * account_id (required UUID), from_date (optional YYYY-MM-DD), and to_date
   * (optional YYYY-MM-DD).
   */
  router.get("/valuation/history", async (req, res, next) => {
    try {
      const accountId = typeof req.query.account_id === "string" ? req.query.account_id : "";
      if (!accountId) {
        res.status(400).json({ detail: "account_id query parameter is required" });
        return;
      }
      const valuationUrl = new URL("/v1/valuation/history", process.env.VALUATION_API_URL ?? "http://mpf-valuation:8000");
      valuationUrl.searchParams.set("account_id", accountId);
      for (const key of ["from_date", "to_date"] as const) {
        const value = req.query[key];
        if (typeof value === "string") valuationUrl.searchParams.set(key, value);
      }
      const response = await fetch(valuationUrl, {
        headers: { "X-API-Key": req.header("X-API-Key") ?? "" }
      });
      const payload = await response.json().catch(() => ({}));
      res.status(response.status).json(payload);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
