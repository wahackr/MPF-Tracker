import { Router } from "express";
import { query } from "../libs/db.js";
import { CreateAccountSchema, UpdateAccountSchema, ensureAccountExists } from "../libs/portfolio.js";

export function registerAccountsRoutes(router: Router): void {
  router.get("/accounts", async (_req, res, next) => {
    try {
      const rows = await query(
        `
        SELECT account_id, provider, scheme, display_label, currency, active
        FROM mpf.accounts
        ORDER BY created_at DESC
        `
      );
      res.json(rows.rows);
    } catch (error) {
      next(error);
    }
  });

  router.post("/accounts", async (req, res, next) => {
    try {
      const payload = CreateAccountSchema.parse(req.body ?? {});
      const rows = await query(
        `
        INSERT INTO mpf.accounts(provider, scheme, display_label, currency)
        VALUES ($1, $2, $3, $4)
        RETURNING account_id, provider, scheme, display_label, currency, active
        `,
        [payload.provider, payload.scheme, payload.display_label, payload.currency.toUpperCase()]
      );
      res.status(201).json(rows.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  router.get("/accounts/:accountId", async (req, res, next) => {
    try {
      const rows = await query(
        `
        SELECT account_id, provider, scheme, display_label, currency, active
        FROM mpf.accounts
        WHERE account_id = $1::uuid
        `,
        [req.params.accountId]
      );
      if (rows.rows.length === 0) {
        res.status(404).json({ detail: "Account not found" });
        return;
      }
      res.json(rows.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  router.put("/accounts/:accountId", async (req, res, next) => {
    try {
      const payload = UpdateAccountSchema.parse(req.body ?? {});
      if (Object.keys(payload).length === 0) {
        res.status(400).json({ detail: "At least one field must be supplied" });
        return;
      }
      await ensureAccountExists(req.params.accountId);
      const rows = await query(
        `
        UPDATE mpf.accounts
        SET display_label = COALESCE($2, display_label),
            currency = COALESCE($3, currency),
            active = COALESCE($4, active),
            updated_at = NOW()
        WHERE account_id = $1::uuid
        RETURNING account_id, provider, scheme, display_label, currency, active
        `,
        [
          req.params.accountId,
          payload.display_label ?? null,
          payload.currency ? payload.currency.toUpperCase() : null,
          payload.active ?? null
        ]
      );
      res.json(rows.rows[0]);
    } catch (error) {
      next(error);
    }
  });
}
