import { and, eq, gte, sql } from "drizzle-orm";
import { startOfTeamDay } from "./clock";
import type { Db } from "./db/client";
import { llmCalls, spendLedger } from "./db/schema";

export type SpendCategory = "llm" | "verify" | "lead_data" | "mailbox" | "domain" | "other";

export class SpendCapError extends Error {
  constructor(
    message: string,
    readonly scope: "daily" | "lead",
  ) {
    super(message);
  }
}

export async function recordSpend(
  db: Db,
  category: SpendCategory,
  amountUsd: number,
  opts: { companyId?: string | null; ref?: string; note?: string; at?: Date } = {},
): Promise<void> {
  if (amountUsd <= 0) return;
  await db.insert(spendLedger).values({
    category,
    amountUsd,
    companyId: opts.companyId ?? null,
    ref: opts.ref ?? null,
    note: opts.note ?? null,
    ...(opts.at ? { createdAt: opts.at } : {}),
  });
}

export async function spendSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${spendLedger.amountUsd}), 0)::float8` })
    .from(spendLedger)
    .where(gte(spendLedger.createdAt, since));
  return Number(row?.total ?? 0);
}

/** Spend recorded under one ref (e.g. a lead vendor) since a point in time. */
export async function refSpendSince(db: Db, ref: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${spendLedger.amountUsd}), 0)::float8` })
    .from(spendLedger)
    .where(and(eq(spendLedger.ref, ref), gte(spendLedger.createdAt, since)));
  return Number(row?.total ?? 0);
}

export async function dailySpend(db: Db, now: Date): Promise<number> {
  return spendSince(db, startOfTeamDay(now));
}

export async function leadLlmSpend(db: Db, companyId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8` })
    .from(llmCalls)
    .where(and(eq(llmCalls.companyId, companyId)));
  return Number(row?.total ?? 0);
}

export async function assertDailySpendOk(db: Db, now: Date, capUsd: number, upcomingUsd = 0): Promise<void> {
  const spent = await dailySpend(db, now);
  if (spent + upcomingUsd > capUsd) {
    throw new SpendCapError(`daily spend cap reached: $${spent.toFixed(4)} of $${capUsd}`, "daily");
  }
}
