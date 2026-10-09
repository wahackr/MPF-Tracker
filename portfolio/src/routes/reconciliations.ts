import { Router } from "express";
import { withTransaction } from "../libs/db.js";
import { ReconciliationSchema, ensureAccountExists, ensureFundExists } from "../libs/portfolio.js";
import { decimalString } from "../libs/rules.js";

export function registerReconciliationsRoutes(router: Router): void {
  router.post("/accounts/:accountId/reconciliations", async (req, res, next) => {
    try {
      const payload = ReconciliationSchema.parse(req.body ?? {});
      await withTransaction(async (client) => {
        await ensureAccountExists(req.params.accountId);
        await client.query(
          `
          INSERT INTO mpf.reconciliation_records (account_id, effective_date, notes)
          VALUES ($1::uuid, $2::date, $3)
          `,
          [req.params.accountId, payload.effective_date, payload.notes ?? null]
        );
        for (const holding of payload.holdings) {
          await ensureFundExists(client, holding.fund_id);
          await client.query(
            `
            INSERT INTO mpf.holdings_baselines (
              account_id, fund_id, effective_date, units, source, verification_status
            )
            VALUES ($1::uuid, $2, $3::date, $4::numeric, 'reconciliation', 'VERIFIED')
            `,
            [req.params.accountId, holding.fund_id, payload.effective_date, decimalString(holding.units)]
          );
        }
        await client.query(
          `
          INSERT INTO mpf.snapshot_invalidation_requests (
            source_service, reason, account_id, from_date
          )
          VALUES ('portfolio', 'reconciliation', $1::uuid, $2::date)
          `,
          [req.params.accountId, payload.effective_date]
        );
      });
      res.status(200).json({
        account_id: req.params.accountId,
        effective_date: payload.effective_date,
        inserted_baselines: payload.holdings.length
      });
    } catch (error) {
      next(error);
    }
  });
}
