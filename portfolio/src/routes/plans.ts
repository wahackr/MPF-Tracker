import { Router } from "express";
import { Decimal } from "decimal.js";
import { query, withTransaction } from "../libs/db.js";
import { ContributionPlanSchema, ensureAccountExists } from "../libs/portfolio.js";

export function registerPlansRoutes(router: Router): void {
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

  router.put("/accounts/:accountId/contribution-plans", async (req, res, next) => {
    try {
      const payload = ContributionPlanSchema.parse(req.body ?? {});
      const amount = new Decimal(payload.amount);
      if (!amount.gt(0)) {
        res.status(400).json({ detail: "amount must be > 0" });
        return;
      }
      const result = await withTransaction(async (client) => {
        await ensureAccountExists(req.params.accountId);
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
