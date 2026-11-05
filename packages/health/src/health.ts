import {
  dailySpend,
  DAY,
  domains,
  events,
  mailboxes,
  pauseDomain,
  pauseMailbox,
  resumeMailbox,
  seedTests,
  setKillSwitch,
  TEAM_TZ_LABEL,
  suppressionLeaks,
  type Ctx,
} from "@opengtm/core";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";

export interface MailboxHealth {
  mailboxId: string;
  email: string;
  sent: number;
  hardBounces: number;
  complaints: number;
  bounceRate: number;
  seedPlacement: number | null;
  healthScore: number;
}

/** Bounce codes that are the recipient server's own problem: 5.2.2 mailbox full, 5.4.6 and 5.4.14 mail loops. */
const RECIPIENT_SIDE = ["5.2.2", "5.4.6", "5.4.14"];

async function countByMailbox(ctx: Ctx, type: "sent" | "bounced_hard" | "complaint", since: Date, mailboxId?: string): Promise<Map<string, number>> {
  // A bounce notice that matches no email we sent (pre-warmed mailboxes keep exchanging warm-up mail,
  // whose bounces land in our inbox too) says nothing about our list, so it doesn't count.
  // Nor does a fault in the recipient's own server (a mail loop, a full mailbox): the address is real and
  // the mailbox did nothing wrong. The address is still suppressed when the bounce comes in.
  const recipientSide = sql.join(
    RECIPIENT_SIDE.map((s) => sql`${s}`),
    sql`, `,
  );
  const ours =
    type === "bounced_hard"
      ? sql`not (${events.messageId} is null and ${events.data} ? 'recipient') and coalesce(${events.data}->>'status', '') not in (${recipientSide})`
      : sql`true`;
  const rows = await ctx.db
    .select({ mailboxId: events.mailboxId, n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.type, type), gte(events.createdAt, since), ours, mailboxId ? eq(events.mailboxId, mailboxId) : undefined))
    .groupBy(events.mailboxId);
  return new Map(rows.filter((r) => r.mailboxId).map((r) => [r.mailboxId!, r.n]));
}

/**
 * When a person resumed each mailbox inside the window (not this check's own resumes). A person who resumes
 * a mailbox is vouching for it, so its bounce rate starts over from then; otherwise the bounces that caused
 * the pause would pause it again at the next check, and a paused mailbox can't send its way back under the limit.
 */
async function resumedByPerson(ctx: Ctx, since: Date): Promise<Map<string, Date>> {
  const rows = await ctx.db
    .select({ mailboxId: events.mailboxId, at: sql<Date>`max(${events.createdAt})` })
    .from(events)
    .where(and(eq(events.type, "resumed"), gte(events.createdAt, since), sql`coalesce(${events.data}->>'actor', '') <> 'health'`))
    .groupBy(events.mailboxId);
  return new Map(rows.filter((r) => r.mailboxId).map((r) => [r.mailboxId!, new Date(r.at)]));
}

export async function seedPlacementByMailbox(ctx: Ctx, since: Date): Promise<Map<string, { inbox: number; total: number }>> {
  const rows = await ctx.db
    .select({ mailboxId: seedTests.mailboxId, placement: seedTests.placement, n: sql<number>`count(*)::int` })
    .from(seedTests)
    .where(and(gte(seedTests.sentAt, since), ne(seedTests.placement, "pending")))
    .groupBy(seedTests.mailboxId, seedTests.placement);
  const out = new Map<string, { inbox: number; total: number }>();
  for (const r of rows) {
    const cur = out.get(r.mailboxId) ?? { inbox: 0, total: 0 };
    cur.total += r.n;
    if (r.placement === "inbox") cur.inbox += r.n;
    out.set(r.mailboxId, cur);
  }
  return out;
}

export function healthScoreOf(bounceRate: number, complaints: number, placement: number | null): number {
  let score = 100 - Math.round(bounceRate * 1500) - complaints * 25;
  if (placement !== null) score -= Math.round((1 - placement) * 100);
  return Math.max(0, Math.min(100, score));
}

const BOUNCE_PAUSE = "hard bounce rate";

/**
 * Guardrails (section 1): pause a mailbox whose hard-bounce rate reaches 2% (at least 2 bounces from our own emails),
 * pause a domain whose complaint rate reaches 0.1%, keep health scores current
 * (the ramp holds at tier 1 below 70), and warn as daily spend nears the cap.
 */
export async function runHealthCheck(ctx: Ctx): Promise<MailboxHealth[]> {
  const h = ctx.config.engine.health;
  const now = ctx.clock.now();
  const since = new Date(now.getTime() - h.bounce_window_days * DAY);
  const [sent, bounces, complaints, seeds, resumed] = await Promise.all([
    countByMailbox(ctx, "sent", since),
    countByMailbox(ctx, "bounced_hard", since),
    countByMailbox(ctx, "complaint", since),
    seedPlacementByMailbox(ctx, since),
    resumedByPerson(ctx, since),
  ]);
  for (const [mailboxId, from] of resumed) {
    const [s, b] = await Promise.all([countByMailbox(ctx, "sent", from, mailboxId), countByMailbox(ctx, "bounced_hard", from, mailboxId)]);
    sent.set(mailboxId, s.get(mailboxId) ?? 0);
    bounces.set(mailboxId, b.get(mailboxId) ?? 0);
  }

  const mbs = await ctx.db.select().from(mailboxes).where(inArray(mailboxes.status, ["active", "warming", "paused"]));
  const out: MailboxHealth[] = [];
  const domainTotals = new Map<string, { sent: number; complaints: number }>();
  for (const mb of mbs) {
    const s = sent.get(mb.id) ?? 0;
    const b = bounces.get(mb.id) ?? 0;
    const c = complaints.get(mb.id) ?? 0;
    const seed = seeds.get(mb.id);
    const placement = seed && seed.total > 0 ? seed.inbox / seed.total : null;
    const rate = s > 0 ? b / s : 0;
    const score = healthScoreOf(rate, c, placement);
    await ctx.db.update(mailboxes).set({ healthScore: score }).where(eq(mailboxes.id, mb.id));
    out.push({ mailboxId: mb.id, email: mb.email, sent: s, hardBounces: b, complaints: c, bounceRate: rate, seedPlacement: placement, healthScore: score });

    const d = domainTotals.get(mb.domainId) ?? { sent: 0, complaints: 0 };
    d.sent += s;
    d.complaints += c;
    domainTotals.set(mb.domainId, d);

    const overBounceLimit = s >= h.bounce_min_sample && b >= h.bounce_min_count && rate >= h.max_bounce_rate;
    if (mb.status === "active" && overBounceLimit) {
      await pauseMailbox(ctx, mb.id, `${BOUNCE_PAUSE} ${(rate * 100).toFixed(1)}% over ${s} sends (${b} bounces, limit ${(h.max_bounce_rate * 100).toFixed(1)}%)`);
    }
    // A mailbox this check paused for bounces goes back to work once the numbers no longer call for it
    // (the rules changed, or the bounces left the window). A pause a person made stays.
    if (mb.status === "paused" && mb.pausedReason?.startsWith(BOUNCE_PAUSE) && !overBounceLimit) {
      await resumeMailbox(ctx, mb.id, "health");
      await ctx.alerts.notify({
        level: "info",
        key: `mailbox_resumed:${mb.id}:${now.toISOString().slice(0, 10)}`,
        quietMs: DAY,
        title: `Mailbox sending again: ${mb.email}`,
        body: `${b} hard bounce${b === 1 ? "" : "s"} from our own emails over ${s} sends in the last ${h.bounce_window_days} days, within the limit (it takes ${h.bounce_min_count} bounces and ${(h.max_bounce_rate * 100).toFixed(1)}%).`,
      });
    }
  }

  for (const [domainId, d] of domainTotals) {
    if (d.complaints > 0 && d.complaints / Math.max(1, d.sent) >= h.max_complaint_rate) {
      const [dom] = await ctx.db.select().from(domains).where(eq(domains.id, domainId));
      if (dom?.status === "active") {
        await pauseDomain(ctx, domainId, `${d.complaints} spam complaint(s) over ${d.sent} sends (limit ${(h.max_complaint_rate * 100).toFixed(2)}%)`);
      }
    }
  }

  const spend = await dailySpend(ctx.db, now);
  const cap = ctx.config.engine.caps.daily_spend_cap_usd;
  if (spend >= cap) {
    await ctx.alerts.notify({ level: "critical", key: "spend_cap_hit", quietMs: DAY, title: "Daily spend cap reached", body: `$${spend.toFixed(2)} of $${cap}. Paid LLM and verification calls are paused until midnight (${TEAM_TZ_LABEL}).` });
  } else if (spend >= cap * 0.8) {
    await ctx.alerts.notify({ level: "warn", key: "spend_cap_80", quietMs: DAY, title: "Daily spend at 80% of cap", body: `$${spend.toFixed(2)} of $${cap}` });
  }

  // Belt and braces: an email that reached someone already on the suppress list means a check was
  // skipped somewhere, so everything stops until a person looks.
  const leaks = await suppressionLeaks(ctx.db, { since: new Date(now.getTime() - DAY) });
  if (leaks.length) {
    await setKillSwitch(ctx.db, true, "health", `sent to ${leaks.length} suppressed address(es)`);
    await ctx.alerts.notify({
      level: "critical",
      key: `suppression_leak:${leaks[0]!.messageId}`,
      title: "Email sent to a suppressed address; sending stopped",
      body: `${leaks.map((l) => `${l.to} (on the list as ${l.entry})`).join(", ")}. The kill switch is on; see the Suppress page.`,
    });
  }
  return out;
}
