import { Decimal } from "decimal.js";

import { query, withTransaction } from "./libs/db.js";
import { expectedDateForMonth, hkToday, monthStart, purchaseUnits, weightsTotalOneHundred } from "./libs/rules.js";

type ProcessPayload = {
  as_of_date?: string;
  account_id?: string;
};

type ConfirmTxInput = {
  fund_id: string;
  cash_amount: string | number;
  unit_price: string | number;
  units_delta: string | number;
  trade_date?: string;
};

// Confirmation replaces the complete transaction set for the event.
type ConfirmPayload = {
  trade_date: string;
  transactions: ConfirmTxInput[];
};

function toDecimal(value: string | number, field: string): Decimal {
  try {
    return new Decimal(value);
  } catch {
    throw new Error(`Invalid decimal for ${field}`);
  }
}

type Plan = {
  plan_id: string;
  account_id: string;
  contribution_stream: string;
  amount: string;
  expected_day: number;
};

type Event = {
  event_id: string;
  plan_id: string;
  expected_date: string;
  status: string;
};

type Allocation = {
  plan_id: string;
  fund_id: string;
  weight: string;
  price_date: string | null;
  price: string | null;
};

export async function processPurchases(payload: ProcessPayload): Promise<Record<string, unknown>> {
  const asOfDate = payload.as_of_date ?? hkToday();
  const period = monthStart(asOfDate);

  return withTransaction(async (client) => {
    // Only create this month's events for plans whose contribution date has arrived.
    const plans = (await client.query<Plan>(
      `SELECT plan_id, account_id, contribution_stream, amount, expected_day
       FROM mpf.contribution_plans
       WHERE effective_from <= $1::date
         AND (effective_to IS NULL OR effective_to >= $1::date)
         AND ($2::uuid IS NULL OR account_id = $2::uuid)
       ORDER BY plan_id`,
      [asOfDate, payload.account_id ?? null]
    )).rows.filter((plan) => expectedDateForMonth(period, plan.expected_day) <= asOfDate);

    const summary = {
      as_of_date: asOfDate,
      processed_events: 0,
      estimated_events: 0,
      waiting_events: 0,
      failed_events: 0,
      inserted_transactions: 0,
      updated_transactions: 0,
      waiting_details: [] as Array<{ event_id: string; reason: string }>
    };

    if (plans.length === 0) return summary;

    // Create missing events together; an existing event keeps its status and original values.
    const planInputs = plans.map((plan) => ({
      ...plan,
      expected_date: expectedDateForMonth(period, plan.expected_day)
    }));

    await client.query(
      `INSERT INTO mpf.contribution_events (plan_id, period, expected_date, amount, status)
       SELECT plan_id, $2::date, expected_date, amount, 'EXPECTED'
       FROM jsonb_to_recordset($1::jsonb) AS p(plan_id uuid, expected_date date, amount numeric)
       ON CONFLICT (plan_id, period) DO NOTHING`,
      [JSON.stringify(planInputs), period]
    );

    // Read after the insert so a concurrently created event is visible, then lock it through commit.
    const events = (await client.query<Event>(
      `SELECT event_id, plan_id, expected_date::text, status
       FROM mpf.contribution_events
       WHERE plan_id = ANY($1::uuid[]) AND period = $2::date
       ORDER BY plan_id FOR UPDATE`,
      [plans.map((plan) => plan.plan_id), period]
    )).rows;

    summary.processed_events = events.length;
    const pending = events.filter((event) => event.status !== "CONFIRMED");

    if (pending.length === 0) return summary;

    // Read each plan's allocation version and first available prices in one query.
    // Missing prices remain in the result so an event cannot be partially estimated.
    const pendingPlanIds = new Set(pending.map((event) => event.plan_id));
    const pendingPlans = planInputs.filter((plan) => pendingPlanIds.has(plan.plan_id));

    const allocations = (await client.query<Allocation>(
      `SELECT p.plan_id, ar.fund_id, ar.weight, price.price_date::text, price.bid AS price
       FROM jsonb_to_recordset($1::jsonb) AS p(
         plan_id uuid, account_id uuid, contribution_stream text, expected_date date
       )
       JOIN mpf.allocation_rules ar ON ar.account_id = p.account_id
         AND ar.contribution_stream = p.contribution_stream
         AND ar.effective_from = (
           SELECT MAX(effective_from) FROM mpf.allocation_rules
           WHERE account_id = p.account_id AND contribution_stream = p.contribution_stream
             AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
         )
       LEFT JOIN LATERAL (
         SELECT price_date, bid FROM mpf.fund_prices
         WHERE fund_id = ar.fund_id AND price_date >= p.expected_date
           AND price_date <= p.expected_date + 14 AND price_date <= $3::date
         ORDER BY price_date LIMIT 1
       ) price ON TRUE
       ORDER BY p.plan_id, ar.fund_id`,
      [JSON.stringify(pendingPlans), period, asOfDate]
    )).rows;

    // Group the batch results before calculating purchases; these loops perform no database calls.
    const plansById = new Map(plans.map((plan) => [plan.plan_id, plan]));
    const allocationsByPlan = new Map<string, Allocation[]>();

    for (const allocation of allocations) {
      const group = allocationsByPlan.get(allocation.plan_id) ?? [];
      group.push(allocation);
      allocationsByPlan.set(allocation.plan_id, group);
    }

    const statuses: Array<{ event_id: string; status: string }> = [];
    const transactions: Array<{
      event_id: string;
      fund_id: string;
      trade_date: string;
      cash_amount: string;
      unit_price: string;
      units_delta: string;
    }> = [];

    for (const event of pending) {
      const plan = plansById.get(event.plan_id)!;
      const funds = allocationsByPlan.get(event.plan_id) ?? [];

      // Reject the entire event if its allocation is missing or does not total 100%.
      if (funds.length === 0 || !weightsTotalOneHundred(funds)) {
        statuses.push({ event_id: event.event_id, status: "FAILED_REVIEW" });
        summary.failed_events += 1;
        continue;
      }

      // Wait for every fund to have a usable price before preparing any purchases.
      if (funds.some((fund) => !fund.price_date || fund.price === null || !new Decimal(fund.price).gt(0))) {
        statuses.push({ event_id: event.event_id, status: "WAITING_FOR_PRICE" });
        summary.waiting_events += 1;
        summary.waiting_details.push({ event_id: event.event_id, reason: "missing_price" });
        continue;
      }

      for (const fund of funds) {
        const cash = new Decimal(plan.amount).mul(fund.weight).div(100);

        transactions.push({
          event_id: event.event_id,
          fund_id: fund.fund_id,
          trade_date: fund.price_date!,
          cash_amount: cash.toFixed(8),
          unit_price: new Decimal(fund.price!).toFixed(10),
          units_delta: purchaseUnits(cash, 100, fund.price!).toFixed(10)
        });
      }

      statuses.push({ event_id: event.event_id, status: "ESTIMATED" });
      summary.estimated_events += 1;
    }

    // Persist all estimates together, preserving confirmed trades and skipping unchanged rows.
    if (transactions.length > 0) {
      const changed = (await client.query<{ event_id: string; inserted: boolean }>(
        `INSERT INTO mpf.purchase_transactions (
           event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy
         )
         SELECT event_id, fund_id, trade_date, cash_amount, unit_price, units_delta,
                'ESTIMATED', 'first_price_on_or_after'
         FROM jsonb_to_recordset($1::jsonb) AS t(
           event_id uuid, fund_id text, trade_date date, cash_amount numeric, unit_price numeric, units_delta numeric
         )
         ON CONFLICT (event_id, fund_id) DO UPDATE SET
           trade_date = EXCLUDED.trade_date, cash_amount = EXCLUDED.cash_amount,
           unit_price = EXCLUDED.unit_price, units_delta = EXCLUDED.units_delta,
           status = 'ESTIMATED', estimation_policy = 'first_price_on_or_after', updated_at = NOW()
         WHERE mpf.purchase_transactions.status <> 'CONFIRMED'
           AND (mpf.purchase_transactions.trade_date, mpf.purchase_transactions.cash_amount,
                mpf.purchase_transactions.unit_price, mpf.purchase_transactions.units_delta)
             IS DISTINCT FROM (EXCLUDED.trade_date, EXCLUDED.cash_amount, EXCLUDED.unit_price, EXCLUDED.units_delta)
         RETURNING event_id, (xmax = 0) AS inserted`,
        [JSON.stringify(transactions)]
      )).rows;

      // Revalue each changed account once, starting at its earliest affected contribution date.
      const eventsById = new Map(pending.map((event) => [event.event_id, event]));
      const changedAccounts = new Map<string, string>();

      for (const change of changed) {
        if (change.inserted) summary.inserted_transactions += 1;
        else summary.updated_transactions += 1;

        const event = eventsById.get(change.event_id)!;
        const accountId = plansById.get(event.plan_id)!.account_id;
        const previous = changedAccounts.get(accountId);

        if (!previous || event.expected_date < previous) changedAccounts.set(accountId, event.expected_date);
      }

      if (changedAccounts.size > 0) {
        await client.query(
          `INSERT INTO mpf.snapshot_invalidation_requests (source_service, reason, account_id, from_date)
           SELECT 'purchase', 'purchase_estimation', account_id, from_date
           FROM jsonb_to_recordset($1::jsonb) AS i(account_id uuid, from_date date)`,
          [JSON.stringify(Array.from(changedAccounts, ([account_id, from_date]) => ({ account_id, from_date })))]
        );
      }
    }

    // Publish the event outcomes in the same transaction as the purchases and invalidations.
    await client.query(
      `UPDATE mpf.contribution_events e SET status = s.status, updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS s(event_id uuid, status text)
       WHERE e.event_id = s.event_id`,
      [JSON.stringify(statuses)]
    );

    return summary;
  });
}

export async function confirmPurchaseEvent(
  eventId: string,
  payload: ConfirmPayload
): Promise<Record<string, unknown>> {
  return withTransaction(async (client) => {
    // Serialize confirmation and estimation of the same event until this transaction commits.
    const eventRows = await client.query(
      `
      SELECT e.event_id, p.account_id
      FROM mpf.contribution_events e
      JOIN mpf.contribution_plans p ON p.plan_id = e.plan_id
      WHERE e.event_id = $1::uuid
      FOR UPDATE OF e
      `,
      [eventId]
    );

    if (eventRows.rows.length === 0) {
      const error = new Error("Contribution event not found");
      (error as Error & { status?: number }).status = 404;
      throw error;
    }

    // Include dates of transactions that will be updated or removed.
    const priorDates = await client.query<{ earliest_date: string | null }>(
      "SELECT MIN(trade_date)::text AS earliest_date FROM mpf.purchase_transactions WHERE event_id = $1::uuid",
      [eventId]
    );
    let changedFromDate = priorDates.rows[0]?.earliest_date ?? null;

    // Confirmation supplies the complete fund set; remove estimates for omitted funds.
    // Any later validation or write failure rolls this deletion back with the transaction.
    await client.query(
      `
      DELETE FROM mpf.purchase_transactions
      WHERE event_id = $1::uuid AND NOT (fund_id = ANY($2::text[]))
      `,
      [eventId, payload.transactions.map((tx) => tx.fund_id)]
    );

    // Normalize decimal precision and collect the earliest new trade date before the batch write.
    const transactions = payload.transactions.map((tx) => {
      if (!tx.fund_id || !tx.fund_id.trim()) {
        throw new Error("transactions[].fund_id is required");
      }

      const tradeDate = tx.trade_date ?? payload.trade_date;
      if (!changedFromDate || tradeDate < changedFromDate) changedFromDate = tradeDate;

      return {
        fund_id: tx.fund_id,
        trade_date: tradeDate,
        cash_amount: toDecimal(tx.cash_amount, "transactions[].cash_amount").toFixed(8),
        unit_price: toDecimal(tx.unit_price, "transactions[].unit_price").toFixed(10),
        units_delta: toDecimal(tx.units_delta, "transactions[].units_delta").toFixed(10)
      };
    });

    // A batch upsert cannot target the same event/fund pair more than once.
    if (new Set(transactions.map((tx) => tx.fund_id)).size !== transactions.length) {
      throw new Error("transactions[].fund_id must be unique");
    }

    await client.query(
      `INSERT INTO mpf.purchase_transactions (
         event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy
       )
       SELECT $1::uuid, fund_id, trade_date, cash_amount, unit_price, units_delta, 'CONFIRMED', 'confirmed'
       FROM jsonb_to_recordset($2::jsonb) AS t(
         fund_id text, trade_date date, cash_amount numeric, unit_price numeric, units_delta numeric
       )
       ON CONFLICT (event_id, fund_id) DO UPDATE SET
         trade_date = EXCLUDED.trade_date, cash_amount = EXCLUDED.cash_amount,
         unit_price = EXCLUDED.unit_price, units_delta = EXCLUDED.units_delta,
         status = 'CONFIRMED', estimation_policy = 'confirmed', updated_at = NOW()`,
      [eventId, JSON.stringify(transactions)]
    );

    await client.query(
      "UPDATE mpf.contribution_events SET status = $2, updated_at = NOW() WHERE event_id = $1::uuid",
      [eventId, "CONFIRMED"]
    );

    // Revalue from the earliest old or new trade, including any funds removed above.
    if (changedFromDate) {
      await client.query(
        `
        INSERT INTO mpf.snapshot_invalidation_requests (
          source_service, reason, account_id, from_date
        )
        VALUES ('purchase', 'purchase_confirmation', $1::uuid, $2::date)
        `,
        [eventRows.rows[0].account_id as string, changedFromDate]
      );
    }

    return { event_id: eventId, confirmed_transactions: transactions.length };
  });
}

export async function listPurchaseEvents(limit: number): Promise<unknown[]> {
  const rows = await query(
    `
    SELECT event_id, plan_id, period, expected_date, amount, status, created_at, updated_at
    FROM mpf.contribution_events
    ORDER BY expected_date DESC, created_at DESC
    LIMIT $1
    `,
    [limit]
  );

  return rows.rows;
}

export async function listPurchaseTransactions(limit: number): Promise<unknown[]> {
  const rows = await query(
    `
    SELECT transaction_id, event_id, fund_id, trade_date, cash_amount, unit_price,
           units_delta, status, estimation_policy, created_at, updated_at
    FROM mpf.purchase_transactions
    ORDER BY trade_date DESC, updated_at DESC
    LIMIT $1
    `,
    [limit]
  );

  return rows.rows;
}
