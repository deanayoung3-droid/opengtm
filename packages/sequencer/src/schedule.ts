import {
  companies,
  contacts,
  DAY,
  messages,
  nextWindowStart,
  sendingBlockers,
  threads,
  timezoneForState,
  type Ctx,
} from "@opengtm/core";
import { and, asc, eq, inArray } from "drizzle-orm";

const APPROVED = ["approved", "auto_approved"] as const;

/**
 * Decide when each thread's next step goes out. Rules:
 * - a drafting thread starts once step 1 is approved
 * - step N is scheduled only after step N-1 was sent, at start + dayOffset,
 *   and only once it is approved
 * - the time is moved into the recipient's local business window
 * - an out-of-office pause pushes the next step past the return date
 * - after the last step is sent the thread completes
 */
export async function scheduleThread(ctx: Ctx, threadId: string): Promise<void> {
  const [t] = await ctx.db.select().from(threads).where(eq(threads.id, threadId));
  if (!t || (t.status !== "drafting" && t.status !== "active")) return;
  const steps = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.kind, "sequence")))
    .orderBy(asc(messages.stepNumber));
  if (steps.length === 0) return;
  const now = ctx.clock.now();

  const next = steps.find((m) => m.status !== "sent" && m.status !== "cancelled");
  if (!next) {
    const anyUnresolved = steps.some((m) => m.status === "unknown" || m.status === "failed");
    await ctx.db.update(threads).set({ status: "completed", stopReason: anyUnresolved ? "completed with failures" : null }).where(eq(threads.id, threadId));
    await ctx.db.update(contacts).set({ status: "completed", updatedAt: now }).where(and(eq(contacts.id, t.contactId), eq(contacts.status, "enrolled")));
    return;
  }
  if (next.status !== "draft") return; // already scheduled / sending / failed / unknown
  if (!APPROVED.includes(next.approvalState as (typeof APPROVED)[number])) return;
  const prev = steps.filter((m) => m.stepNumber < next.stepNumber);
  if (prev.some((m) => m.status !== "sent" && m.status !== "cancelled")) return;

  const [company] = await ctx.db.select().from(companies).where(eq(companies.id, t.companyId));
  const tz = timezoneForState(company?.state);
  // Day offsets count from when step 1 actually went out.
  const base = steps[0]?.sentAt ?? now;
  let due = new Date(Math.max(now.getTime(), base.getTime() + next.dayOffset * DAY));
  if (t.pausedUntil && t.pausedUntil > due) due = t.pausedUntil;
  const at = nextWindowStart(due, tz, ctx.config.engine.timing);

  await ctx.db.update(messages).set({ status: "scheduled", scheduledFor: at }).where(and(eq(messages.id, next.id), eq(messages.status, "draft")));
  if (t.status === "drafting") {
    await ctx.db.update(threads).set({ status: "active", startedAt: now }).where(eq(threads.id, threadId));
  }
}

/** Sweep threads that may have a newly schedulable step (approval just landed, previous step sent, etc). */
export async function runSchedule(ctx: Ctx, limit = 500): Promise<number> {
  if (sendingBlockers(ctx.config).length) return 0; // never activate while compliance config is incomplete
  const rows = await ctx.db
    .selectDistinct({ id: threads.id })
    .from(threads)
    .innerJoin(messages, eq(messages.threadId, threads.id))
    .where(and(inArray(threads.status, ["drafting", "active"]), eq(messages.status, "draft"), inArray(messages.approvalState, [...APPROVED])))
    .limit(limit);
  for (const r of rows) await scheduleThread(ctx, r.id);
  return rows.length;
}
