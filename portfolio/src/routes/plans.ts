import { Router } from "express";
import { Decimal } from "decimal.js";
import { query, withTransaction } from "../libs/db.js";
import { ContributionPlanSchema, ensureAccountExists } from "../libs/portfolio.js";

export function registerPlansRoutes(router: Router): void {
  /**
   * GET /v1/accounts/:accountId/contribution-history
   * Lists processed contribution events and their estimated or confirmed
   * transactions. Path parameter: accountId (UUID).
   */
  router.get("/accounts/:accountId/contribution-history", async (req, res, next) => {
    try {
      await ensureAccountExists(req.params.accountId);
      const rows = await query(
        `
        SELECT
          ce.event_id,
          ce.period::text,
          ce.expected_date::text,
          ce.amount::text,
          ce.status,
          ce.created_at,
          cp.contribution_stream,
          COALESCE(
            json_agg(
              json_build_object(
                'fund_id', pt.fund_id,
                'trade_date', pt.trade_date::text,
                'cash_amount', pt.cash_amount::text,
                'unit_price', pt.unit_price::text,
                'units_delta', pt.units_delta::text,
                'status', pt.status
              ) ORDER BY pt.trade_date, pt.fund_id
            ) FILTER (WHERE pt.transaction_id IS NOT NULL),
            '[]'::json
          ) AS transactions
        FROM mpf.contribution_events ce
        JOIN mpf.contribution_plans cp ON cp.plan_id = ce.plan_id
        LEFT JOIN mpf.purchase_transactions pt ON pt.event_id = ce.event_id
        WHERE cp.account_id = $1::uuid
        GROUP BY ce.event_id, cp.contribution_stream
        ORDER BY ce.expected_date DESC, ce.created_at DESC
        `,
        [req.params.accountId]
      );
      res.json({ account_id: req.params.accountId, count: rows.rows.length, items: rows.rows });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /v1/accounts/:accountId/contribution-plans
   * Lists current and historical contribution plans. Path parameter: accountId
   * (UUID).
   */
  router.get("/accounts/:accountId/contribution-plans", async (req, res, next) => {
    try {
      await ensureAccountExists(req.params.accountId);
      const rows = await query(
        `
        SELECT plan_id, contribution_stream, amount, expected_day, effective_from, effective_to, active, created_at
        FROM mpf.contribution_plans
        WHERE account_id = $1::uuid
        ORDER BY effective_from DESC, created_at DESC
        `,
        [req.params.accountId]
      );
      res.json({ account_id: req.params.accountId, items: rows.rows });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /v1/accounts/:accountId/contribution-plans
   * Replaces the active plan for one contribution stream. Path parameter:
   * accountId (UUID). Body: contribution_stream, positive amount, expected_day
   * (1-31), effective_from, and optional effective_to.
   */
  router.put("/accounts/:accountId/contribution-plans", async (req, res, next) => {
    try {
      const payload = ContributionPlanSchema.parse(req.body ?? {});
      const amount = new Decimal(payload.amount);
      if (!amount.gt(0)) {
        res.status(400).json({ detail: "amount must be > 0" });
        return;
      }
      const result = await withTransaction(async (client) => {
        // Validate the account on this transaction's connection.
        const account = await client.query("SELECT 1 FROM mpf.accounts WHERE account_id = $1::uuid", [req.params.accountId]);
        if (account.rows.length === 0) {
          const error = new Error("Account not found");
          (error as Error & { status?: number }).status = 404;
          throw error;
        }

        await client.query(
          `
          UPDATE mpf.contribution_plans
          SET active = FALSE,
              effective_to = ($1::date - INTERVAL '1 day')::date,
              updated_at = NOW()
          WHERE account_id = $2::uuid
            AND contribution_stream = $3
            AND active = TRUE
          `,
          [payload.effective_from, req.params.accountId, payload.contribution_stream.toLowerCase()]
        );
        const inserted = await client.query(
          `
          INSERT INTO mpf.contribution_plans (
            account_id, contribution_stream, amount, expected_day,
            effective_from, effective_to, active
          )
          VALUES ($1::uuid, $2, $3::numeric, $4, $5::date, $6::date, TRUE)
          RETURNING plan_id
          `,
          [
            req.params.accountId,
            payload.contribution_stream.toLowerCase(),
            amount.toFixed(8),
            payload.expected_day,
            payload.effective_from,
            payload.effective_to ?? null
          ]
        );
        return inserted.rows[0];
      });

      res.json({
        plan_id: result.plan_id,
        account_id: req.params.accountId,
        contribution_stream: payload.contribution_stream.toLowerCase()
      });
    } catch (error) {
      next(error);
    }
  });
}
