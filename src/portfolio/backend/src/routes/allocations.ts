import { Router } from "express";
import { query, withTransaction } from "../libs/db.js";
import { AllocationRuleSchema, ensureAccountExists } from "../libs/portfolio.js";
import { allocationWeightError, decimalString } from "../libs/rules.js";

export function registerAllocationsRoutes(router: Router): void {
  /**
   * GET /v1/accounts/:accountId/allocation-rules
   * Lists current and historical allocation rules. Path parameter: accountId
   * (UUID).
   */
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

  /**
   * PUT /v1/accounts/:accountId/allocation-rules
   * Versions the allocation for one contribution stream. Path parameter:
   * accountId (UUID). Body: effective_from, optional effective_to,
   * contribution_stream, and allocations[] containing fund_id and weight. The
   * submitted weights must total exactly 100.
   */
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
        // Validate the account on this transaction's connection.
        const account = await client.query("SELECT 1 FROM mpf.accounts WHERE account_id = $1::uuid", [req.params.accountId]);
        if (account.rows.length === 0) {
          const error = new Error("Account not found");
          (error as Error & { status?: number }).status = 404;
          throw error;
        }

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

        // Validate and insert the new version as one batch; errors roll back the retired version too.
        const allocations = payload.allocations.map((item) => ({
          fund_id: item.fund_id,
          weight: decimalString(item.weight)
        }));
        const funds = await client.query("SELECT fund_id FROM mpf.funds WHERE fund_id = ANY($1::text[])", [allocations.map((item) => item.fund_id)]);
        const knownFunds = new Set(funds.rows.map((fund) => fund.fund_id));
        const missing = allocations.find((item) => !knownFunds.has(item.fund_id));
        if (missing) throw new Error(`Fund not found: ${missing.fund_id}`);

        await client.query(
          `INSERT INTO mpf.allocation_rules (account_id, fund_id, contribution_stream, effective_from, effective_to, weight)
           SELECT $1::uuid, fund_id, $2, $3::date, $4::date, weight
           FROM jsonb_to_recordset($5::jsonb) AS a(fund_id text, weight numeric)`,
          [req.params.accountId, payload.contribution_stream.toLowerCase(), payload.effective_from,
          payload.effective_to ?? null, JSON.stringify(allocations)]
        );
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
