import {
  campaigns,
  companies,
  contacts,
  events,
  meetings,
  messages,
  recordEvent,
  replies,
  segments,
  spendLedger,
  threads,
  type Ctx,
  type ReplyLabel,
} from "@opengtm/core";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

export const POSITIVE_LABELS: ReplyLabel[] = ["interested", "question", "referral"];
/** Automatic answers: away notices, bounces, "moved to a new address" and "no longer at the company". */
const NOT_HUMAN: ReplyLabel[] = ["out_of_office", "bounce", "email_changed", "recipient_gone"];

export interface ReplySourceRow {
  /** contacts.source: ai_ark, csv, referral... */
  source: string;
  /** The matched ICP role, "role_address" for info@-style addresses, or "other" for any other title. */
  who: string;
  emailed: number;
  /** People who wrote back themselves (any label but the automatic ones and unclear "other"). */
  real: number;
  positive: number;
  /** Away notices and "moved / no longer here" answers. */
  auto: number;
  bounced: number;
}

/**
 * Where real replies come from: per lead source and per kind of person, how many we emailed and how many
 * wrote back themselves, answered automatically or bounced. Each person counts once per outcome.
 */
export async function replySources(ctx: Ctx, since: Date = EPOCH): Promise<ReplySourceRow[]> {
  const emailed = await ctx.db
    .selectDistinct({ id: contacts.id, source: contacts.source, role: contacts.role, roleAddress: contacts.isRoleAddress })
    .from(messages)
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .where(and(eq(messages.status, "sent"), eq(messages.kind, "sequence"), gte(messages.sentAt, since)));
  const answers = await ctx.db
    .select({ contactId: replies.contactId, label: replies.label })
    .from(replies)
    .where(and(isNotNull(replies.label), gte(replies.receivedAt, since)));
  const labelsBy = new Map<string, Set<ReplyLabel>>();
  for (const a of answers) if (a.contactId) (labelsBy.get(a.contactId) ?? labelsBy.set(a.contactId, new Set()).get(a.contactId)!).add(a.label!);

  const rows = new Map<string, ReplySourceRow>();
  for (const c of emailed) {
    const who = c.roleAddress ? "role_address" : (c.role ?? "other");
    const key = `${c.source}|${who}`;
    const row = rows.get(key) ?? { source: c.source, who, emailed: 0, real: 0, positive: 0, auto: 0, bounced: 0 };
    rows.set(key, row);
    row.emailed++;
    const labels = [...(labelsBy.get(c.id) ?? [])];
    if (labels.some((l) => !NOT_HUMAN.includes(l) && l !== "other")) row.real++;
    if (labels.some((l) => POSITIVE_LABELS.includes(l))) row.positive++;
    if (labels.some((l) => l !== "bounce" && NOT_HUMAN.includes(l))) row.auto++;
    if (labels.includes("bounce")) row.bounced++;
  }
  return [...rows.values()].sort((a, b) => b.emailed - a.emailed);
}

export interface FunnelRow {
  segmentId: string;
  status: string;
  sourced: number;
  verified: number;
  emailed: number;
  sends: number;
  replied: number;
  positive: number;
  /** Replies flagged as hot leads, shown on the dashboard. */
  hot: number;
  booked: number;
  held: number;
  won: number;
  costUsd: number;
  replyRate: number;
  positiveRate: number;
  costPerPositive: number | null;
  costPerMeeting: number | null;
}

const EPOCH = new Date(0);

/** Leads sourced -> verified -> emailed -> replied -> positive -> booked -> held -> won, per segment. */
export async function segmentFunnel(ctx: Ctx, since: Date = EPOCH): Promise<FunnelRow[]> {
  const segs = await ctx.db.select().from(segments);
  const rows = new Map<string, FunnelRow>(
    segs.map((s) => [
      s.id,
      { segmentId: s.id, status: s.status, sourced: 0, verified: 0, emailed: 0, sends: 0, replied: 0, positive: 0, hot: 0, booked: 0, held: 0, won: 0, costUsd: 0, replyRate: 0, positiveRate: 0, costPerPositive: null, costPerMeeting: null },
    ]),
  );
  const add = (seg: string | null, key: keyof FunnelRow, n: number) => {
    const r = seg ? rows.get(seg) : undefined;
    if (r) (r[key] as number) += Number(n);
  };

  for (const r of await ctx.db.select({ seg: companies.segmentId, n: sql<number>`count(*)::int` }).from(companies).where(gte(companies.createdAt, since)).groupBy(companies.segmentId)) add(r.seg, "sourced", r.n);
  for (const r of await ctx.db
    .select({ seg: companies.segmentId, n: sql<number>`count(*)::int` })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.verifyStatus, "valid"), gte(contacts.createdAt, since)))
    .groupBy(companies.segmentId))
    add(r.seg, "verified", r.n);
  for (const r of await ctx.db
    .select({ seg: campaigns.segmentId, n: sql<number>`count(distinct ${messages.contactId})::int`, sends: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(campaigns, eq(campaigns.id, threads.campaignId))
    .where(and(eq(messages.status, "sent"), eq(messages.kind, "sequence"), gte(messages.sentAt, since)))
    .groupBy(campaigns.segmentId)) {
    add(r.seg, "emailed", r.n);
    add(r.seg, "sends", r.sends);
  }
  for (const r of await ctx.db
    .select({ seg: campaigns.segmentId, label: replies.label, n: sql<number>`count(*)::int` })
    .from(replies)
    .innerJoin(threads, eq(threads.id, replies.threadId))
    .innerJoin(campaigns, eq(campaigns.id, threads.campaignId))
    .where(and(isNotNull(replies.label), gte(replies.receivedAt, since)))
    .groupBy(campaigns.segmentId, replies.label)) {
    if (NOT_HUMAN.includes(r.label!)) continue;
    add(r.seg, "replied", r.n);
    if (POSITIVE_LABELS.includes(r.label!)) add(r.seg, "positive", r.n);
  }
  for (const r of await ctx.db
    .select({ seg: campaigns.segmentId, n: sql<number>`count(*)::int` })
    .from(replies)
    .innerJoin(threads, eq(threads.id, replies.threadId))
    .innerJoin(campaigns, eq(campaigns.id, threads.campaignId))
    .where(and(eq(replies.hot, true), gte(replies.receivedAt, since)))
    .groupBy(campaigns.segmentId))
    add(r.seg, "hot", r.n);
  for (const r of await ctx.db
    .select({ seg: companies.segmentId, stage: meetings.stage, n: sql<number>`count(*)::int` })
    .from(meetings)
    .innerJoin(companies, eq(companies.id, meetings.companyId))
    .where(gte(meetings.createdAt, since))
    .groupBy(companies.segmentId, meetings.stage)) {
    // Stages are cumulative: a won deal was also booked and held.
    if (["booked", "held", "won"].includes(r.stage)) add(r.seg, "booked", r.n);
    if (["held", "won"].includes(r.stage)) add(r.seg, "held", r.n);
    if (r.stage === "won") add(r.seg, "won", r.n);
  }
  for (const r of await ctx.db
    .select({ seg: companies.segmentId, usd: sql<number>`coalesce(sum(${spendLedger.amountUsd}),0)::float8` })
    .from(spendLedger)
    .innerJoin(companies, eq(companies.id, spendLedger.companyId))
    .where(gte(spendLedger.createdAt, since))
    .groupBy(companies.segmentId))
    add(r.seg, "costUsd", r.usd);

  for (const r of rows.values()) {
    r.replyRate = r.sends ? r.replied / r.emailed || 0 : 0;
    r.positiveRate = r.emailed ? r.positive / r.emailed : 0;
    r.costPerPositive = r.positive ? r.costUsd / r.positive : null;
    r.costPerMeeting = r.booked ? r.costUsd / r.booked : null;
  }
  return [...rows.values()];
}

export interface StepVariantRow {
  segmentId: string;
  step: number;
  variant: string;
  sends: number;
  replies: number;
  positive: number;
  costUsd: number;
}

/** Sends, replies, positives, and copy cost per segment x step x variant. Replies credit the step they answered. */
export async function stepVariantStats(ctx: Ctx, since: Date = EPOCH): Promise<StepVariantRow[]> {
  const key = (s: string, st: number, v: string) => `${s}|${st}|${v}`;
  const out = new Map<string, StepVariantRow>();
  const get = (s: string, st: number, v: string) => {
    const k = key(s, st, v);
    let r = out.get(k);
    if (!r) out.set(k, (r = { segmentId: s, step: st, variant: v, sends: 0, replies: 0, positive: 0, costUsd: 0 }));
    return r;
  };
  for (const r of await ctx.db
    .select({ seg: campaigns.segmentId, step: messages.stepNumber, variant: messages.variant, n: sql<number>`count(*)::int`, usd: sql<number>`coalesce(sum(${messages.costUsd}),0)::float8` })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(campaigns, eq(campaigns.id, threads.campaignId))
    .where(and(eq(messages.status, "sent"), eq(messages.kind, "sequence"), gte(messages.sentAt, since)))
    .groupBy(campaigns.segmentId, messages.stepNumber, messages.variant)) {
    const row = get(r.seg, r.step, r.variant);
    row.sends += r.n;
    row.costUsd += r.usd;
  }
  for (const r of await ctx.db
    .select({ seg: campaigns.segmentId, step: messages.stepNumber, variant: messages.variant, label: replies.label })
    .from(replies)
    .innerJoin(messages, eq(messages.id, replies.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(campaigns, eq(campaigns.id, threads.campaignId))
    .where(and(isNotNull(replies.label), gte(replies.receivedAt, since)))) {
    if (NOT_HUMAN.includes(r.label!)) continue;
    const row = get(r.seg, r.step, r.variant);
    row.replies++;
    if (POSITIVE_LABELS.includes(r.label!)) row.positive++;
  }
  return [...out.values()].sort((a, b) => a.segmentId.localeCompare(b.segmentId) || a.step - b.step || a.variant.localeCompare(b.variant));
}

/**
 * Auto-pause a segment after >= N sends with zero positive replies, and flag
 * segments whose cost per positive reply exceeds the cap.
 */
export async function runSegmentGuards(ctx: Ctx): Promise<{ paused: string[]; flagged: string[] }> {
  const l = ctx.config.engine.learning;
  const funnel = await segmentFunnel(ctx);
  const paused: string[] = [];
  const flagged: string[] = [];
  for (const r of funnel) {
    if (r.status === "active" && r.sends >= l.auto_pause_min_sends && r.positive === 0) {
      await ctx.db
        .update(segments)
        .set({ status: "paused", pausedReason: `${r.sends} sends, 0 positive replies`, updatedAt: ctx.clock.now() })
        .where(eq(segments.id, r.segmentId));
      await recordEvent(ctx.db, "paused", { segmentId: r.segmentId, data: { reason: "no positive replies", sends: r.sends }, at: ctx.clock.now() });
      await ctx.alerts.notify({ level: "warn", key: `segment_paused:${r.segmentId}`, title: `Segment paused: ${r.segmentId}`, body: `${r.sends} sends with no positive replies. Review copy or targeting before resuming.` });
      paused.push(r.segmentId);
    }
    if (r.costPerPositive !== null && r.costPerPositive > l.max_cost_per_positive_usd) {
      await ctx.alerts.notify({ level: "warn", key: `segment_cost:${r.segmentId}`, title: `Segment over cost cap: ${r.segmentId}`, body: `$${r.costPerPositive.toFixed(2)} per positive reply (cap $${l.max_cost_per_positive_usd})` });
      flagged.push(r.segmentId);
    }
  }
  return { paused, flagged };
}

/** North-star: total metered spend / meetings booked in the period. */
export async function costPerMeeting(ctx: Ctx, since: Date = EPOCH): Promise<{ spend: number; meetings: number; costPerMeeting: number | null }> {
  const [s] = await ctx.db.select({ usd: sql<number>`coalesce(sum(${spendLedger.amountUsd}),0)::float8` }).from(spendLedger).where(gte(spendLedger.createdAt, since));
  const [m] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(meetings)
    .where(and(inArray(meetings.stage, ["booked", "held", "won"]), gte(meetings.createdAt, since)));
  const spend = Number(s?.usd ?? 0);
  const n = m?.n ?? 0;
  return { spend, meetings: n, costPerMeeting: n ? spend / n : null };
}

export async function sendsSince(ctx: Ctx, since: Date): Promise<number> {
  const [r] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(events).where(and(eq(events.type, "sent"), gte(events.createdAt, since)));
  return r?.n ?? 0;
}
