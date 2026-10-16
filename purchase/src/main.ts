import { Decimal } from "decimal.js";

import { withTransaction } from "./libs/db.js";
import { expectedDateForMonth, hkToday, monthStart, purchaseUnits, weightsTotalOneHundred } from "./libs/rules.js";
import { findPriceForEstimation, loadPlansEffectiveOn, loadAllocations, setEventStatus, upsertContributionEvent, upsertEstimatedTransaction } from "./libs/repository.js";

export { listPurchaseEvents, listPurchaseTransactions } from "./libs/repository.js";

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

function toDecimal(value: string | number, field: string): Decimal {
  try {
    return new Decimal(value);
  } catch {
    throw new Error(`Invalid decimal for ${field}`);
  }
}

export async function processPurchases(
  payload: ProcessPayload,
  runTransaction: typeof withTransaction = withTransaction
): Promise<Record<string, unknown>> {
  const asOfDate = payload.as_of_date ?? hkToday();
  const accountId = payload.account_id;
  const result = await runTransaction(async (client) => {
    const plans = await loadPlansEffectiveOn(client, asOfDate, accountId);

    let processedEvents = 0;
    let estimatedEvents = 0;
    let waitingEvents = 0;
    let failedEvents = 0;
    let insertedTransactions = 0;
    let updatedTransactions = 0;
    const changedFromDates = new Map<string, string>();
    const waitingDetails: Array<{ event_id: string; reason: string }> = [];

    for (const plan of plans) {
      const period = monthStart(asOfDate);
      const expectedDate = expectedDateForMonth(period, Number(plan.expected_day));
      if (expectedDate > asOfDate) continue;
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

      if (!weightsTotalOneHundred(allocations)) {
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
        const pricePoint = await findPriceForEstimation(client, allocation.fund_id, expectedDate, 14, asOfDate);
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
        const unitsDelta = purchaseUnits(allocation.cash_amount, 100, allocation.unit_price);
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
          // Estimated trades are never earlier than the expected date, including before an update.
          const previousDate = changedFromDates.get(plan.account_id);
          if (!previousDate || expectedDate < previousDate) {
            changedFromDates.set(plan.account_id, expectedDate);
          }
        }
      }

      await setEventStatus(client, event.event_id, "ESTIMATED");
      estimatedEvents += 1;
    }

    for (const [changedAccountId, changedFromDate] of changedFromDates) {
      await client.query(
        `
        INSERT INTO mpf.snapshot_invalidation_requests (
          source_service, reason, account_id, from_date
        )
        VALUES ('purchase', 'purchase_estimation', $1::uuid, $2::date)
        `,
        [changedAccountId, changedFromDate]
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

export async function confirmPurchaseEvent(
  eventId: string,
  payload: ConfirmPayload,
  runTransaction: typeof withTransaction = withTransaction
): Promise<Record<string, unknown>> {
  return runTransaction(async (client) => {
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

    const priorDates = await client.query<{ earliest_date: string | null }>(
      "SELECT MIN(trade_date)::text AS earliest_date FROM mpf.purchase_transactions WHERE event_id = $1::uuid",
      [eventId]
    );
    let changedFromDate = priorDates.rows[0]?.earliest_date ?? null;
    let confirmed = 0;
    for (const tx of payload.transactions) {
      if (!tx.fund_id || !tx.fund_id.trim()) {
        throw new Error("transactions[].fund_id is required");
      }
      const cashAmount = toDecimal(tx.cash_amount, "transactions[].cash_amount");
      const unitPrice = toDecimal(tx.unit_price, "transactions[].unit_price");
      const unitsDelta = toDecimal(tx.units_delta, "transactions[].units_delta");
      const tradeDate = tx.trade_date ?? payload.trade_date;
      await client.query(
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
        `,
        [eventId, tx.fund_id, tradeDate, cashAmount.toFixed(8), unitPrice.toFixed(10), unitsDelta.toFixed(10)]
      );
      confirmed += 1;
      if (!changedFromDate || tradeDate < changedFromDate) {
        changedFromDate = tradeDate;
      }
    }

    await setEventStatus(client, eventId, "CONFIRMED");
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

    return { event_id: eventId, confirmed_transactions: confirmed };
  });
}
