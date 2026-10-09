import { Router } from "express";
import { Decimal } from "decimal.js";
import { z } from "zod";

import { query, withTransaction } from "./db.js";

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CreateAccountSchema = z.object({
  provider: z.string().min(1).max(64),
  scheme: z.string().min(1).max(64),
  display_label: z.string().min(1).max(255),
  currency: z.string().length(3).default("HKD")
});

const UpdateAccountSchema = z.object({
  display_label: z.string().min(1).max(255).optional(),
  currency: z.string().length(3).optional(),
  active: z.boolean().optional()
});

const BaselineSchema = z.object({
  effective_date: DateString,
  source: z.string().min(1).max(64),
  verification_status: z.enum(["VERIFIED", "ESTIMATED"]),
  holdings: z.array(
    z.object({
      fund_id: z.string().min(1),
      units: z.union([z.string(), z.number()])
    })
  ).min(1)
});

const AllocationRuleSchema = z.object({
  effective_from: DateString,
  effective_to: DateString.optional(),
  contribution_stream: z.string().min(1).max(32),
  allocations: z.array(
    z.object({
      fund_id: z.string().min(1),
      weight: z.union([z.string(), z.number()])
    })
  ).min(1)
});

const ContributionPlanSchema = z.object({
  contribution_stream: z.string().min(1).max(32),
  amount: z.union([z.string(), z.number()]),
  expected_day: z.number().int().min(1).max(31),
  effective_from: DateString,
  effective_to: DateString.optional()
});

const ReconciliationSchema = z.object({
  effective_date: DateString,
  notes: z.string().optional(),
  holdings: z.array(
    z.object({
      fund_id: z.string().min(1),
      units: z.union([z.string(), z.number()])
    })
  ).min(1)
});

async function ensureAccountExists(accountId: string): Promise<void> {
  const result = await query("SELECT 1 FROM mpf.accounts WHERE account_id = $1::uuid", [accountId]);
  if (result.rows.length === 0) {
    const error = new Error("Account not found");
    (error as Error & { status?: number }).status = 404;
    throw error;
  }
}

async function ensureFundExists(client: { query: typeof query }, fundId: string): Promise<void> {
  const result = await client.query("SELECT 1 FROM mpf.funds WHERE fund_id = $1", [fundId]);
  if (result.rows.length === 0) {
    throw new Error(`Fund not found: ${fundId}`);
  }
}

function decimalString(value: string | number): string {
  return new Decimal(value).toFixed();
}

export function portfolioRouter(): Router {
  const router = Router();

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
      let total = new Decimal(0);
      for (const item of payload.allocations) {
        const weight = new Decimal(item.weight);
        if (weight.lt(0)) {
          res.status(400).json({ detail: "allocations[].weight must be >= 0" });
          return;
        }
        total = total.plus(weight);
      }
      if (!total.eq(100)) {
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

  return router;
}
