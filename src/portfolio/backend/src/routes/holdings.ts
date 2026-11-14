import { Router } from "express";
import { query, withTransaction } from "../libs/db.js";
import { BaselineSchema, ensureAccountExists } from "../libs/portfolio.js";
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
        // Validate the account on this transaction's connection.
        const account = await client.query("SELECT 1 FROM mpf.accounts WHERE account_id = $1::uuid", [req.params.accountId]);
        if (account.rows.length === 0) {
          const error = new Error("Account not found");
          (error as Error & { status?: number }).status = 404;
          throw error;
        }

        // Validate funds together, then insert all balances in one statement.
        const holdings = payload.holdings.map((holding) => ({
          fund_id: holding.fund_id,
          units: decimalString(holding.units)
        }));
        const funds = await client.query("SELECT fund_id FROM mpf.funds WHERE fund_id = ANY($1::text[])", [holdings.map((holding) => holding.fund_id)]);
        const knownFunds = new Set(funds.rows.map((fund) => fund.fund_id));
        const missing = holdings.find((holding) => !knownFunds.has(holding.fund_id));
        if (missing) throw new Error(`Fund not found: ${missing.fund_id}`);

        await client.query(
          `INSERT INTO mpf.holdings_baselines (account_id, fund_id, effective_date, units, source, verification_status)
           SELECT $1::uuid, fund_id, $2::date, units, $3, $4
           FROM jsonb_to_recordset($5::jsonb) AS h(fund_id text, units numeric)`,
          [req.params.accountId, payload.effective_date, payload.source, payload.verification_status, JSON.stringify(holdings)]
        );

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
