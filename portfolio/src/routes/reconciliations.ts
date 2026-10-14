import { Router } from "express";
import { query, withTransaction } from "../libs/db.js";
import { ReconciliationSchema, ensureAccountExists, ensureFundExists } from "../libs/portfolio.js";
import { decimalString } from "../libs/rules.js";

export function registerReconciliationsRoutes(router: Router): void {
  /**
   * GET /v1/accounts/:accountId/reconciliations
   * Lists reconciliation records with the verified balances recorded on each date.
   */
  router.get("/accounts/:accountId/reconciliations", async (req, res, next) => {
    try {
      await ensureAccountExists(req.params.accountId);
      const result = await query(
        `
        SELECT
          rr.reconciliation_id,
          rr.effective_date::text,
          rr.notes,
          rr.created_at,
          COALESCE(
            json_agg(json_build_object('fund_id', hb.fund_id, 'units', hb.units::text))
              FILTER (WHERE hb.baseline_id IS NOT NULL),
            '[]'::json
          ) AS holdings
        FROM mpf.reconciliation_records rr
        LEFT JOIN mpf.holdings_baselines hb
          ON hb.account_id = rr.account_id
          AND hb.effective_date = rr.effective_date
          AND hb.source = 'reconciliation'
        WHERE rr.account_id = $1::uuid
        GROUP BY rr.reconciliation_id
        ORDER BY rr.effective_date DESC, rr.created_at DESC
        `,
        [req.params.accountId]
      );
      res.json({ account_id: req.params.accountId, items: result.rows });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /v1/accounts/:accountId/reconciliations
   * Appends an authoritative eMPF reconciliation, creates verified holding
   * baselines, and invalidates derived snapshots. Path parameter: accountId
   * (UUID). Body: effective_date, optional notes, and holdings[] containing
   * fund_id and units.
   */
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
