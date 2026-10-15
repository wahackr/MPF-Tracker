import { z } from "zod";
import { query } from "./db.js";

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreateAccountSchema = z.object({
  provider: z.string().min(1).max(64),
  scheme: z.string().min(1).max(64),
  display_label: z.string().min(1).max(255),
  currency: z.string().length(3).default("HKD")
});

export const UpdateAccountSchema = z.object({
  display_label: z.string().min(1).max(255).optional(),
  currency: z.string().length(3).optional(),
  active: z.boolean().optional()
});

export const BaselineSchema = z.object({
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

export const AllocationRuleSchema = z.object({
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

export const ContributionPlanSchema = z.object({
  contribution_stream: z.string().min(1).max(32),
  amount: z.union([z.string(), z.number()]),
  expected_day: z.number().int().min(1).max(31),
  effective_from: DateString,
  effective_to: DateString.optional()
});

export const ReconciliationSchema = z.object({
  effective_date: DateString,
  notes: z.string().optional(),
  holdings: z.array(
    z.object({
      fund_id: z.string().min(1),
      units: z.union([z.string(), z.number()])
    })
  ).min(1)
});

export async function ensureAccountExists(accountId: string): Promise<void> {
  const result = await query("SELECT 1 FROM mpf.accounts WHERE account_id = $1::uuid", [accountId]);
  if (result.rows.length === 0) {
    const error = new Error("Account not found");
    (error as Error & { status?: number }).status = 404;
    throw error;
  }
}

export async function ensureFundExists(client: { query: typeof query }, fundId: string): Promise<void> {
  const result = await client.query("SELECT 1 FROM mpf.funds WHERE fund_id = $1", [fundId]);
  if (result.rows.length === 0) {
    throw new Error(`Fund not found: ${fundId}`);
  }
}
