import { Router } from "express";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { query, withTransaction } from "../libs/db.js";
import { ensureAccountExists } from "../libs/portfolio.js";

const Units = z.string().regex(/^\d{1,14}(\.\d{1,10})?$/)
  .refine((value) => new Decimal(value).gt(0), "Units must be positive");
const SwitchHeader = z.object({
  switch_id: z.string().uuid(),
  trade_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Invalid trade date"),
  notes: z.string().max(2000).default("")
});
const Leg = z.object({ fund_id: z.string().min(1), units: Units });
const SwitchSchema = z.union([
  SwitchHeader.extend({ sales: z.array(Leg).min(1).max(100), purchases: z.array(Leg).min(1).max(100) }).strict(),
  // Accept the original API payload for existing clients.
  SwitchHeader.extend({ from_fund_id: z.string().min(1), to_fund_id: z.string().min(1),
    units_sold: Units, units_bought: Units }).strict().transform((value) => ({
      switch_id: value.switch_id, trade_date: value.trade_date, notes: value.notes,
      sales: [{ fund_id: value.from_fund_id, units: value.units_sold }],
      purchases: [{ fund_id: value.to_fund_id, units: value.units_bought }]
    }))
]).refine((value) => {
  const ids = [...value.sales, ...value.purchases].map((leg) => leg.fund_id);
  return new Set(ids).size === ids.length;
}, "Each fund may appear only once in a switch, on either the sold or bought side");

type LegInput = { fund_id: string; units: string; side: string };
function canonicalLegs(legs: LegInput[]): string {
  return JSON.stringify(legs.map((leg) => ({ fund_id: leg.fund_id, side: leg.side, units: new Decimal(leg.units).toFixed(10) }))
    .sort((a, b) => a.fund_id.localeCompare(b.fund_id)));
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export function registerSwitchesRoutes(router: Router): void {
  router.get("/accounts/:accountId/switches", async (req, res, next) => {
    try {
      z.string().uuid().parse(req.params.accountId);
      await ensureAccountExists(req.params.accountId);
      const rows = await query(
        `SELECT s.switch_id, s.trade_date::text, s.notes, s.created_at,
                COALESCE(json_agg(json_build_object('fund_id', l.fund_id, 'units', l.units::text)
                  ORDER BY l.fund_id) FILTER (WHERE l.side = 'SOLD'), '[]'::json) AS sales,
                COALESCE(json_agg(json_build_object('fund_id', l.fund_id, 'units', l.units::text)
                  ORDER BY l.fund_id) FILTER (WHERE l.side = 'BOUGHT'), '[]'::json) AS purchases
         FROM mpf.fund_switches s JOIN mpf.fund_switch_legs l ON l.switch_id = s.switch_id
         WHERE s.account_id = $1::uuid GROUP BY s.switch_id
         ORDER BY s.trade_date DESC, s.created_at DESC`, [req.params.accountId]
      );
      res.json({ account_id: req.params.accountId, items: rows.rows });
    } catch (error) { next(error); }
  });

  router.post("/accounts/:accountId/switches", async (req, res, next) => {
    try {
      const accountId = z.string().uuid().parse(req.params.accountId);
      const payload = SwitchSchema.parse(req.body ?? {});
      const legs: LegInput[] = [
        ...payload.sales.map((leg) => ({ ...leg, side: "SOLD" })),
        ...payload.purchases.map((leg) => ({ ...leg, side: "BOUGHT" }))
      ];
      const fundIds = legs.map((leg) => leg.fund_id);
      const result = await withTransaction(async (client) => {
        // Serialize switches for an account, including duplicate submissions.
        const account = (await client.query(
          "SELECT provider, currency FROM mpf.accounts WHERE account_id = $1::uuid FOR UPDATE", [accountId]
        )).rows[0];
        if (!account) fail(404, "Account not found");
        const previous = (await client.query(
          "SELECT *, trade_date::text AS trade_date_text FROM mpf.fund_switches WHERE switch_id = $1::uuid", [payload.switch_id]
        )).rows[0];
        if (previous) {
          const savedLegs = (await client.query<LegInput>(
            "SELECT fund_id, side, units::text FROM mpf.fund_switch_legs WHERE switch_id = $1::uuid", [payload.switch_id]
          )).rows;
          const matches = previous.account_id === accountId && previous.trade_date_text === payload.trade_date &&
            previous.notes === payload.notes && canonicalLegs(savedLegs) === canonicalLegs(legs);
          if (!matches) fail(409, "Switch ID is already used for a different switch");
          return { switch_id: payload.switch_id, created: false };
        }
        const funds = (await client.query(
          "SELECT fund_id, provider, currency FROM mpf.funds WHERE fund_id = ANY($1::text[])",
          [fundIds]
        )).rows;
        if (funds.length !== fundIds.length) fail(400, "Fund not found");
        if (funds.some((fund) => fund.provider.toLowerCase() !== account.provider.toLowerCase() || fund.currency !== account.currency)) {
          fail(400, "All funds must match the account provider and currency");
        }
        // Baselines describe end-of-day balances; a same-day switch is already included.
        const sameDay = await client.query(
          `SELECT 1 FROM mpf.holdings_baselines WHERE account_id = $1::uuid
           AND fund_id = ANY($2::text[]) AND effective_date = $3::date LIMIT 1`,
          [accountId, fundIds, payload.trade_date]
        );
        if (sameDay.rows.length) fail(409, "A baseline exists on this date; reconcile the end-of-day balances instead");
        await client.query(
          `INSERT INTO mpf.fund_switches (switch_id, account_id, trade_date, notes)
           VALUES ($1::uuid, $2::uuid, $3::date, $4)`,
          [payload.switch_id, accountId, payload.trade_date, payload.notes]
        );
        await client.query(
          `INSERT INTO mpf.fund_switch_legs (switch_id, fund_id, side, units)
           SELECT $1::uuid, fund_id, side, units FROM jsonb_to_recordset($2::jsonb)
           AS l(fund_id text, side text, units numeric)`, [payload.switch_id, JSON.stringify(legs)]
        );
        // Check this sale and later recorded sales, so backdated switches cannot oversell.
        // Only confirmed purchases count as units available to switch.
        for (const sale of payload.sales) {
          const balances = (await client.query<{ units: string }>(
            `WITH dates AS (
               SELECT DISTINCT s.trade_date FROM mpf.fund_switches s
               JOIN mpf.fund_switch_legs l ON l.switch_id = s.switch_id
               WHERE s.account_id = $1::uuid AND l.fund_id = $2 AND l.side = 'SOLD' AND s.trade_date >= $3::date
             )
             SELECT (COALESCE(b.units, 0) + COALESCE(p.units, 0) + COALESCE(s.units, 0))::text AS units
             FROM dates d
             LEFT JOIN LATERAL (
               SELECT units, effective_date FROM mpf.holdings_baselines
               WHERE account_id = $1::uuid AND fund_id = $2 AND effective_date <= d.trade_date
               ORDER BY effective_date DESC, created_at DESC, baseline_id DESC LIMIT 1
             ) b ON TRUE
             LEFT JOIN LATERAL (
               SELECT SUM(pt.units_delta) AS units FROM mpf.purchase_transactions pt
               JOIN mpf.contribution_events ce ON ce.event_id = pt.event_id
               JOIN mpf.contribution_plans cp ON cp.plan_id = ce.plan_id
               WHERE cp.account_id = $1::uuid AND pt.fund_id = $2 AND pt.status = 'CONFIRMED'
                 AND (pt.trade_date > b.effective_date OR (b.effective_date IS NULL AND pt.trade_date >= (
                   SELECT MIN(s.trade_date) FROM mpf.fund_switches s
                   JOIN mpf.fund_switch_legs l ON l.switch_id = s.switch_id
                   WHERE s.account_id = $1::uuid AND l.fund_id = $2 AND l.side = 'BOUGHT'
                 ))) AND pt.trade_date <= d.trade_date
             ) p ON TRUE
             LEFT JOIN LATERAL (
               SELECT SUM(CASE WHEN l.side = 'SOLD' THEN -l.units ELSE l.units END) AS units
               FROM mpf.fund_switches s JOIN mpf.fund_switch_legs l ON l.switch_id = s.switch_id
               WHERE s.account_id = $1::uuid AND l.fund_id = $2
                 AND s.trade_date > COALESCE(b.effective_date, '-infinity'::date) AND s.trade_date <= d.trade_date
             ) s ON TRUE`, [accountId, sale.fund_id, payload.trade_date]
          )).rows;
          if (balances.some((balance) => new Decimal(balance.units).lt(0))) {
            fail(400, "Insufficient confirmed units for this switch or a later recorded switch");
          }
        }
        await client.query(
          `INSERT INTO mpf.snapshot_invalidation_requests (source_service, reason, account_id, from_date)
           VALUES ('portfolio', 'fund_switch', $1::uuid, $2::date)`, [accountId, payload.trade_date]
        );
        return { switch_id: payload.switch_id, created: true };
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) { next(error); }
  });
}
