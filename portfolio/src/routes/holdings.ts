import { Router } from "express";
import { query, withTransaction } from "../libs/db.js";
import { BaselineSchema, ensureAccountExists, ensureFundExists } from "../libs/portfolio.js";
import { decimalString } from "../libs/rules.js";

export function registerHoldingsRoutes(router: Router): void {
  /**
   * GET /v1/accounts/:accountId/holdings
   * Lists every recorded holding baseline for an account. Path parameter:
   * accountId (UUID).
   */
  router.get("/accounts/:accountId/holdings", async (req, res, next) => {
    try {
      await ensureAccountExists(req.params.accountId);
      const rows = await query(
        `
        SELECT baseline_id, fund_id, effective_date, units, source, verification_status, created_at
        FROM mpf.holdings_baselines
        WHERE account_id = $1::uuid
        ORDER BY effective_date DESC, created_at DESC
        `,
        [req.params.accountId]
      );
      res.json({ account_id: req.params.accountId, items: rows.rows });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /v1/accounts/:accountId/baselines
   * Records a dated set of fund unit balances and invalidates derived snapshots.
   * Path parameter: accountId (UUID). Body: effective_date, source,
   * verification_status (VERIFIED or ESTIMATED), and holdings[] containing
   * fund_id and units.
   */
  router.post("/accounts/:accountId/baselines", async (req, res, next) => {
    try {
      const payload = BaselineSchema.parse(req.body ?? {});
      await withTransaction(async (client) => {
        await ensureAccountExists(req.params.accountId);
        for (const holding of payload.holdings) {
          await ensureFundExists(client, holding.fund_id);
          await client.query(
            `
            INSERT INTO mpf.holdings_baselines (
              account_id, fund_id, effective_date, units, source, verification_status
            )
            VALUES ($1::uuid, $2, $3::date, $4::numeric, $5, $6)
            `,
            [
              req.params.accountId,
              holding.fund_id,
              payload.effective_date,
              decimalString(holding.units),
              payload.source,
              payload.verification_status
            ]
          );
        }
        await client.query(
          `
          INSERT INTO mpf.snapshot_invalidation_requests (
            source_service, reason, account_id, from_date
          )
          VALUES ('portfolio', 'baseline_update', $1::uuid, $2::date)
          `,
          [req.params.accountId, payload.effective_date]
        );
      });
      res.status(200).json({ account_id: req.params.accountId, inserted_baselines: payload.holdings.length });
    } catch (error) {
      next(error);
    }
  });
}
