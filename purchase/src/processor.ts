import { Decimal } from "decimal.js";
import { PoolClient } from "pg";

import { query, withTransaction } from "./db.js";

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

type ConfirmPayload = {
  trade_date: string;
  transactions: ConfirmTxInput[];
};

function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

function expectedDateForMonth(period: string, expectedDay: number): string {
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(expectedDay, lastDay);
  return `${period.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

function toDecimal(value: string | number, field: string): Decimal {
  try {
    return new Decimal(value);
  } catch {
    throw new Error(`Invalid decimal for ${field}`);
  }
}

async function loadActivePlans(client: PoolClient, asOfDate: string, accountId: string | undefined) {
  const params: unknown[] = [asOfDate];
  let accountFilter = "";
  if (accountId) {
    accountFilter = "AND account_id = $2::uuid";
    params.push(accountId);
  }
  const rows = await client.query(
    `
    SELECT plan_id, account_id, contribution_stream, amount, expected_day
    FROM mpf.contribution_plans
    WHERE active = TRUE
      AND effective_from <= $1::date
      AND (effective_to IS NULL OR effective_to >= $1::date)
      ${accountFilter}
    ORDER BY plan_id
    `,
    params
  );
  return rows.rows;
}

async function upsertContributionEvent(
  client: PoolClient,
  planId: string,
  period: string,
  expectedDate: string,
  amount: string
) {
  const row = await client.query(
    `
    INSERT INTO mpf.contribution_events (
      plan_id, period, expected_date, amount, status
    )
    VALUES ($1::uuid, $2::date, $3::date, $4::numeric, 'EXPECTED')
    ON CONFLICT (plan_id, period)
    DO UPDATE SET
      expected_date = EXCLUDED.expected_date,
      amount = EXCLUDED.amount,
      updated_at = NOW()
    RETURNING event_id, status
    `,
    [planId, period, expectedDate, amount]
  );
  return row.rows[0] as { event_id: string; status: string };
}

async function loadAllocations(
  client: PoolClient,
  accountId: string,
  contributionStream: string,
  period: string
) {
  const rows = await client.query(
    `
    WITH selected_version AS (
      SELECT MAX(effective_from) AS effective_from
      FROM mpf.allocation_rules
      WHERE account_id = $1::uuid
        AND contribution_stream = $2
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
    )
    SELECT ar.fund_id, ar.weight
    FROM mpf.allocation_rules ar
    JOIN selected_version sv ON ar.effective_from = sv.effective_from
    WHERE ar.account_id = $1::uuid
      AND ar.contribution_stream = $2
    ORDER BY ar.fund_id
    `,
    [accountId, contributionStream, period]
  );
  return rows.rows as { fund_id: string; weight: string }[];
}

async function findPriceForEstimation(
  client: PoolClient,
  fundId: string,
  expectedDate: string,
  maxDelayDays: number
): Promise<{ price_date: string; price: string } | null> {
  const rows = await client.query(
    `
    SELECT fp.price_date,
           CASE
             WHEN f.provider = 'hsbc' THEN fp.bid
             WHEN f.provider = 'manulife' THEN fp.nav
             ELSE COALESCE(fp.nav, fp.bid, fp.offer)
           END AS price
    FROM mpf.fund_prices fp
    JOIN mpf.funds f ON f.fund_id = fp.fund_id
    WHERE fp.fund_id = $1
      AND fp.price_date >= $2::date
      AND fp.price_date <= ($2::date + ($3::int * INTERVAL '1 day'))::date
    ORDER BY fp.price_date ASC
    LIMIT 1
    `,
    [fundId, expectedDate, maxDelayDays]
  );
  if (rows.rows.length === 0 || rows.rows[0].price === null) {
    return null;
  }
  return rows.rows[0] as { price_date: string; price: string };
}

async function setEventStatus(client: PoolClient, eventId: string, status: string): Promise<void> {
  await client.query(
    `
    UPDATE mpf.contribution_events
    SET status = $2, updated_at = NOW()
    WHERE event_id = $1::uuid
    `,
    [eventId, status]
  );
}

async function upsertEstimatedTransaction(
  client: PoolClient,
  eventId: string,
  fundId: string,
  tradeDate: string,
  cashAmount: Decimal,
  unitPrice: Decimal,
  unitsDelta: Decimal
): Promise<{ inserted: boolean; changed: boolean }> {
  const row = await client.query(
    `
    INSERT INTO mpf.purchase_transactions (
      event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy
    )
    VALUES ($1::uuid, $2, $3::date, $4::numeric, $5::numeric, $6::numeric, 'ESTIMATED', 'first_price_on_or_after')
    ON CONFLICT (event_id, fund_id)
    DO UPDATE SET
      trade_date = EXCLUDED.trade_date,
      cash_amount = EXCLUDED.cash_amount,
      unit_price = EXCLUDED.unit_price,
      units_delta = EXCLUDED.units_delta,
      status = CASE
          WHEN mpf.purchase_transactions.status = 'CONFIRMED' THEN mpf.purchase_transactions.status
          ELSE 'ESTIMATED'
      END,
      estimation_policy = CASE
          WHEN mpf.purchase_transactions.status = 'CONFIRMED' THEN mpf.purchase_transactions.estimation_policy
          ELSE 'first_price_on_or_after'
      END,
      updated_at = NOW()
    WHERE mpf.purchase_transactions.status <> 'CONFIRMED'
      AND (
        mpf.purchase_transactions.trade_date IS DISTINCT FROM EXCLUDED.trade_date
        OR mpf.purchase_transactions.cash_amount IS DISTINCT FROM EXCLUDED.cash_amount
        OR mpf.purchase_transactions.unit_price IS DISTINCT FROM EXCLUDED.unit_price
        OR mpf.purchase_transactions.units_delta IS DISTINCT FROM EXCLUDED.units_delta
      )
    RETURNING (xmax = 0) AS inserted
    `,
    [eventId, fundId, tradeDate, cashAmount.toFixed(8), unitPrice.toFixed(10), unitsDelta.toFixed(10)]
  );
  if (row.rows.length === 0) {
    return { inserted: false, changed: false };
  }
  return { inserted: Boolean(row.rows[0].inserted), changed: true };
}

export async function processPurchases(payload: ProcessPayload): Promise<Record<string, unknown>> {
  const asOfDate = payload.as_of_date ?? new Date().toISOString().slice(0, 10);
  const accountId = payload.account_id;
  const result = await withTransaction(async (client) => {
    const plans = await loadActivePlans(client, asOfDate, accountId);

    let processedEvents = 0;
    let estimatedEvents = 0;
    let waitingEvents = 0;
    let failedEvents = 0;
    let insertedTransactions = 0;
    let updatedTransactions = 0;
    let changedFromDate: string | null = null;
    let changedToDate: string | null = null;
    const waitingDetails: Array<{ event_id: string; reason: string }> = [];

    for (const plan of plans) {
      const period = monthStart(asOfDate);
      const expectedDate = expectedDateForMonth(period, Number(plan.expected_day));
      const event = await upsertContributionEvent(client, plan.plan_id, period, expectedDate, String(plan.amount));
      processedEvents += 1;
      if (event.status === "CONFIRMED") {
        continue;
      }

      const allocations = await loadAllocations(client, plan.account_id, plan.contribution_stream, period);
      if (allocations.length === 0) {
        await setEventStatus(client, event.event_id, "FAILED_REVIEW");
        failedEvents += 1;
        continue;
      }

      let totalWeight = new Decimal(0);
      for (const allocation of allocations) {
        totalWeight = totalWeight.plus(new Decimal(allocation.weight));
      }
      if (!totalWeight.eq(100)) {
        await setEventStatus(client, event.event_id, "FAILED_REVIEW");
        failedEvents += 1;
        continue;
      }

      const amount = new Decimal(plan.amount);
      const pricedAllocations: Array<{
        fund_id: string;
        trade_date: string;
        cash_amount: Decimal;
        unit_price: Decimal;
      }> = [];
      let missingPrice = false;
      for (const allocation of allocations) {
        const weight = new Decimal(allocation.weight);
        const cashAmount = amount.mul(weight).div(100);
        const pricePoint = await findPriceForEstimation(client, allocation.fund_id, expectedDate, 14);
        if (!pricePoint) {
          missingPrice = true;
          break;
        }
        pricedAllocations.push({
          fund_id: allocation.fund_id,
          trade_date: pricePoint.price_date,
          cash_amount: cashAmount,
          unit_price: new Decimal(pricePoint.price)
        });
      }

      if (missingPrice) {
        await setEventStatus(client, event.event_id, "WAITING_FOR_PRICE");
        waitingEvents += 1;
        waitingDetails.push({ event_id: event.event_id, reason: "missing_price" });
        continue;
      }

      for (const allocation of pricedAllocations) {
        const unitsDelta = allocation.cash_amount.div(allocation.unit_price);
        const upserted = await upsertEstimatedTransaction(
          client,
          event.event_id,
          allocation.fund_id,
          allocation.trade_date,
          allocation.cash_amount,
          allocation.unit_price,
          unitsDelta
        );
        if (upserted.changed) {
          if (upserted.inserted) {
            insertedTransactions += 1;
          } else {
            updatedTransactions += 1;
          }
          if (!changedFromDate || allocation.trade_date < changedFromDate) {
            changedFromDate = allocation.trade_date;
          }
          if (!changedToDate || allocation.trade_date > changedToDate) {
            changedToDate = allocation.trade_date;
          }
        }
      }

      await setEventStatus(client, event.event_id, "ESTIMATED");
      estimatedEvents += 1;
    }

    if (changedFromDate) {
      await client.query(
        `
        INSERT INTO mpf.snapshot_invalidation_requests (
          source_service, reason, account_id, from_date, to_date
        )
        VALUES ('purchase', 'purchase_estimation', $1::uuid, $2::date, $3::date)
        `,
        [accountId ?? null, changedFromDate, changedToDate]
      );
    }

    return {
      as_of_date: asOfDate,
      processed_events: processedEvents,
      estimated_events: estimatedEvents,
      waiting_events: waitingEvents,
      failed_events: failedEvents,
      inserted_transactions: insertedTransactions,
      updated_transactions: updatedTransactions,
      waiting_details: waitingDetails
    };
  });
  return result;
}

export async function confirmPurchaseEvent(eventId: string, payload: ConfirmPayload): Promise<Record<string, unknown>> {
  return withTransaction(async (client) => {
    const eventRows = await client.query(
      `
      SELECT e.event_id, p.account_id
      FROM mpf.contribution_events e
      JOIN mpf.contribution_plans p ON p.plan_id = e.plan_id
      WHERE e.event_id = $1::uuid
      `,
      [eventId]
    );
    if (eventRows.rows.length === 0) {
      const error = new Error("Contribution event not found");
      (error as Error & { status?: number }).status = 404;
      throw error;
    }

    let changedFromDate: string | null = null;
    let changedToDate: string | null = null;
    let confirmed = 0;
    for (const tx of payload.transactions) {
      if (!tx.fund_id || !tx.fund_id.trim()) {
        throw new Error("transactions[].fund_id is required");
      }
      const cashAmount = toDecimal(tx.cash_amount, "transactions[].cash_amount");
      const unitPrice = toDecimal(tx.unit_price, "transactions[].unit_price");
      const unitsDelta = toDecimal(tx.units_delta, "transactions[].units_delta");
      const tradeDate = tx.trade_date ?? payload.trade_date;
      const rows = await client.query(
        `
        INSERT INTO mpf.purchase_transactions (
          event_id, fund_id, trade_date, cash_amount, unit_price, units_delta, status, estimation_policy
        )
        VALUES ($1::uuid, $2, $3::date, $4::numeric, $5::numeric, $6::numeric, 'CONFIRMED', 'confirmed')
        ON CONFLICT (event_id, fund_id)
        DO UPDATE SET
          trade_date = EXCLUDED.trade_date,
          cash_amount = EXCLUDED.cash_amount,
          unit_price = EXCLUDED.unit_price,
          units_delta = EXCLUDED.units_delta,
          status = 'CONFIRMED',
          estimation_policy = 'confirmed',
          updated_at = NOW()
        RETURNING trade_date
        `,
        [eventId, tx.fund_id, tradeDate, cashAmount.toFixed(8), unitPrice.toFixed(10), unitsDelta.toFixed(10)]
      );
      confirmed += 1;
      const txDate = rows.rows[0].trade_date as string;
      if (!changedFromDate || txDate < changedFromDate) {
        changedFromDate = txDate;
      }
      if (!changedToDate || txDate > changedToDate) {
        changedToDate = txDate;
      }
    }

    await setEventStatus(client, eventId, "CONFIRMED");
    if (changedFromDate) {
      await client.query(
        `
        INSERT INTO mpf.snapshot_invalidation_requests (
          source_service, reason, account_id, from_date, to_date
        )
        VALUES ('purchase', 'purchase_confirmation', $1::uuid, $2::date, $3::date)
        `,
        [eventRows.rows[0].account_id as string, changedFromDate, changedToDate]
      );
    }

    return { event_id: eventId, confirmed_transactions: confirmed };
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
