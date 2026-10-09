import { Router } from "express";
import { query, withTransaction } from "../libs/db.js";
import { AllocationRuleSchema, ensureAccountExists, ensureFundExists } from "../libs/portfolio.js";
import { allocationWeightError, decimalString } from "../libs/rules.js";

export function registerAllocationsRoutes(router: Router): void {
  router.get("/accounts/:accountId/allocation-rules", async (req, res, next) => {
    try {
      await ensureAccountExists(req.params.accountId);
      const rows = await query(
        `
        SELECT rule_id, fund_id, contribution_stream, effective_from, effective_to, weight, created_at
        FROM mpf.allocation_rules
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

  router.put("/accounts/:accountId/allocation-rules", async (req, res, next) => {
    try {
      const payload = AllocationRuleSchema.parse(req.body ?? {});
      const weightError = allocationWeightError(payload.allocations);
      if (weightError === "negative") {
        res.status(400).json({ detail: "allocations[].weight must be >= 0" });
        return;
      }
      if (weightError === "total") {
        res.status(400).json({ detail: "allocation weights must sum to exactly 100" });
        return;
      }

      await withTransaction(async (client) => {
        await ensureAccountExists(req.params.accountId);
        await client.query(
          `
          UPDATE mpf.allocation_rules
          SET effective_to = ($1::date - INTERVAL '1 day')::date,
              updated_at = NOW()
          WHERE account_id = $2::uuid
            AND contribution_stream = $3
            AND (effective_to IS NULL OR effective_to >= $1::date)
          `,
          [payload.effective_from, req.params.accountId, payload.contribution_stream.toLowerCase()]
        );

        for (const item of payload.allocations) {
          await ensureFundExists(client, item.fund_id);
          await client.query(
            `
            INSERT INTO mpf.allocation_rules (
              account_id, fund_id, contribution_stream, effective_from, effective_to, weight
            )
            VALUES ($1::uuid, $2, $3, $4::date, $5::date, $6::numeric)
            `,
            [
              req.params.accountId,
              item.fund_id,
              payload.contribution_stream.toLowerCase(),
              payload.effective_from,
              payload.effective_to ?? null,
              decimalString(item.weight)
            ]
          );
        }
      });

      res.json({
        account_id: req.params.accountId,
        contribution_stream: payload.contribution_stream.toLowerCase(),
        effective_from: payload.effective_from,
        allocation_count: payload.allocations.length
      });
    } catch (error) {
      next(error);
    }
  });
}
