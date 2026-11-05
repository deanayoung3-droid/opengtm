import {
  campaigns,
  companies,
  contacts,
  events,
  isKillSwitchOn,
  isSuppressed,
  isWithinWindow,
  mailboxes,
  domains,
  messages,
  MINUTE,
  nextWindowStart,
  pauseMailbox,
  recordEvent,
  segments,
  sendingBlockers,
  startOfTeamDay,
  suppress,
  threads,
  timezoneForState,
  teamDay,
  type Ctx,
} from "@opengtm/core";
import { and, asc, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { emailHtml, outgoingBody } from "@opengtm/writer";
import { listUnsubscribe, newMessageId, type OutgoingEmail } from "./headers";
import { dailyCap, jitterMs } from "./ramp";
import { scheduleThread } from "./schedule";
import { SendError, type MailTransport } from "./transports";

type Mailbox = typeof mailboxes.$inferSelect;

export interface SendDeps {
  transportFor: (mb: Mailbox) => MailTransport;
  publicBaseUrl?: string;
  unsubscribeSecret?: string;
}

export interface SendTickResult {
  sent: number;
  failed: number;
  rescheduled: number;
  skipped?: "kill_switch" | "config_incomplete" | "daily_cap";
}

const MAX_ATTEMPTS = 3;
const STUCK_AFTER = 10 * MINUTE;

export async function sentSince(ctx: Ctx, since: Date): Promise<number> {
  const [r] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(events).where(and(eq(events.type, "sent"), gte(events.createdAt, since)));
  return r?.n ?? 0;
}

/**
 * A message stuck in "sending" means the process died between locking it and
 * recording the result. We cannot know whether the provider accepted it, so it
 * is marked "unknown" for a human to resolve; it is never resent automatically.
 */
export async function recoverStuckSends(ctx: Ctx): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - STUCK_AFTER);
  const stuck = await ctx.db
    .update(messages)
    .set({ status: "unknown", lastError: "process stopped mid-send; check the mailbox Sent folder" })
    .where(and(eq(messages.status, "sending"), isNotNull(messages.claimedAt), lt(messages.claimedAt, cutoff)))
    .returning();
  for (const m of stuck) {
    await recordEvent(ctx.db, "send_unknown", { messageId: m.id, threadId: m.threadId, mailboxId: m.mailboxId, at: ctx.clock.now() });
    await ctx.alerts.notify({
      level: "critical",
      key: `send_unknown:${m.id}`,
      title: "Send outcome unknown",
      body: `Message ${m.id} (step ${m.stepNumber}) may or may not have been delivered. Check Sent, then mark it sent or cancel it.`,
    });
  }
  return stuck.length;
}

/**
 * One pass of the sender. Each mailbox sends at most one message per tick and
 * then waits a random 30-300s, so the worker can tick every minute.
 */
export async function runSendTick(ctx: Ctx, deps: SendDeps): Promise<SendTickResult> {
  const res: SendTickResult = { sent: 0, failed: 0, rescheduled: 0 };
  const now = ctx.clock.now();
  if (await isKillSwitchOn(ctx.db)) return { ...res, skipped: "kill_switch" };
  const blockers = sendingBlockers(ctx.config);
  if (blockers.length) {
    await ctx.alerts.notify({ level: "warn", key: "sending_blocked_config", title: "Sending blocked by missing config", body: blockers.map((b) => b.field).join(", ") });
    return { ...res, skipped: "config_incomplete" };
  }
  await recoverStuckSends(ctx);

  const cap = ctx.config.engine.caps.daily_send_cap;
  let sentToday = await sentSince(ctx, startOfTeamDay(now));
  if (sentToday >= cap) return { ...res, skipped: "daily_cap" };

  const mbRows = await ctx.db
    .select({ mb: mailboxes })
    .from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(and(eq(mailboxes.status, "active"), eq(domains.status, "active")));
  const order = mbRows.map((r) => ({ mb: r.mb, k: ctx.random() })).sort((a, b) => a.k - b.k);
  const today = teamDay(now);

  for (const { mb } of order) {
    if (sentToday >= cap) break;
    if (mb.nextSendAt && mb.nextSendAt > now) continue;
    const mbSentToday = mb.sentTodayDate === today ? mb.sentToday : 0;
    if (mbSentToday >= dailyCap(mb, now, ctx.config.engine.ramp)) continue;

    let transport: MailTransport;
    try {
      transport = deps.transportFor(mb);
    } catch (err) {
      await pauseMailbox(ctx, mb.id, `transport unavailable: ${(err as Error).message}`);
      continue;
    }

    const due = await ctx.db
      .select({ m: messages, t: threads, c: contacts, co: companies, segmentId: campaigns.segmentId })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .innerJoin(companies, eq(companies.id, threads.companyId))
      .innerJoin(campaigns, eq(campaigns.id, threads.campaignId))
      .innerJoin(segments, eq(segments.id, campaigns.segmentId))
      .where(
        and(
          eq(threads.mailboxId, mb.id),
          eq(threads.status, "active"),
          eq(messages.status, "scheduled"),
          lte(messages.scheduledFor, now),
          inArray(messages.approvalState, ["approved", "auto_approved"]),
          eq(campaigns.status, "active"),
          eq(segments.status, "active"),
        ),
      )
      .orderBy(asc(messages.scheduledFor))
      .limit(10);

    for (const { m, t, c, co, segmentId } of due) {
      const tz = timezoneForState(co.state);
      const timing = ctx.config.engine.timing;
      if (t.pausedUntil && t.pausedUntil > now) {
        await ctx.db.update(messages).set({ scheduledFor: nextWindowStart(t.pausedUntil, tz, timing) }).where(eq(messages.id, m.id));
        res.rescheduled++;
        continue;
      }
      if (!isWithinWindow(now, tz, timing)) {
        await ctx.db.update(messages).set({ scheduledFor: nextWindowStart(now, tz, timing) }).where(eq(messages.id, m.id));
        res.rescheduled++;
        continue;
      }
      if (await isSuppressed(ctx.db, c.email, co.domain)) {
        await suppress(ctx.db, { email: c.email }, "suppressed before send", "sequencer"); // stops the thread
        continue;
      }
      // A dropped contact (not interested, moved, mailbox gone) is never emailed again, even with a follow-up already queued.
      if (c.status === "dropped") {
        await ctx.db.update(threads).set({ status: "stopped", stopReason: `contact dropped: ${c.dropReason ?? "no reason"}` }).where(eq(threads.id, t.id));
        await ctx.db.update(messages).set({ status: "cancelled" }).where(and(eq(messages.threadId, t.id), inArray(messages.status, ["draft", "scheduled"])));
        continue;
      }

      // Threading: reply to the previous message we sent in this thread.
      const prior = await ctx.db
        .select({ rfc: messages.rfcMessageId })
        .from(messages)
        .where(and(eq(messages.threadId, t.id), eq(messages.status, "sent"), isNotNull(messages.rfcMessageId), lt(messages.stepNumber, m.stepNumber)))
        .orderBy(asc(messages.stepNumber));
      const refs = prior.map((p) => p.rfc!).filter(Boolean);
      const rfc = m.rfcMessageId ?? newMessageId(mb.email);
      // Every email carries the mailbox's current signature (name, title, phone), even one written earlier.
      const sender = { name: mb.senderName, title: mb.senderTitle, phone: mb.senderPhone };
      const body = outgoingBody(m.body, ctx.config, sender);
      const rich = emailHtml(body, sender, ctx.config);

      // Lock before the provider call: a second worker (or a retry) cannot send it again.
      const [claimed] = await ctx.db
        .update(messages)
        .set({
          status: "sending",
          claimedAt: now,
          body, // exactly what goes out
          sendAttempts: sql`${messages.sendAttempts} + 1`,
          mailboxId: mb.id,
          rfcMessageId: rfc,
          inReplyTo: refs.at(-1) ?? null,
          references: refs.length ? refs.join(" ") : null,
        })
        .where(and(eq(messages.id, m.id), eq(messages.status, "scheduled")))
        .returning();
      if (!claimed) continue;

      const email: OutgoingEmail = {
        from: { name: mb.senderName, address: mb.email },
        replyTo: mb.email,
        to: c.email,
        subject: m.subject,
        text: body,
        ...(rich ? { html: rich.html, inline: rich.inline } : {}),
        messageId: rfc,
        inReplyTo: refs.at(-1),
        references: refs.length ? refs : undefined,
        listUnsubscribe: listUnsubscribe({ mailbox: mb.email, contactId: c.id, baseUrl: deps.publicBaseUrl, secret: deps.unsubscribeSecret }),
      };

      try {
        await transport.send(email);
      } catch (err) {
        res.failed++;
        await handleSendError(ctx, mb, claimed, c.email, err);
        break;
      }

      await ctx.db.update(messages).set({ status: "sent", sentAt: now, lastError: null }).where(eq(messages.id, m.id));
      await ctx.db
        .update(mailboxes)
        .set({ sentToday: mbSentToday + 1, sentTodayDate: today, nextSendAt: new Date(now.getTime() + jitterMs(ctx.random, timing.jitter_min_s, timing.jitter_max_s)) })
        .where(eq(mailboxes.id, mb.id));
      await recordEvent(ctx.db, "sent", { messageId: m.id, threadId: t.id, contactId: c.id, mailboxId: mb.id, segmentId, data: { step: m.stepNumber, variant: m.variant }, at: now });
      sentToday++;
      res.sent++;
      await scheduleThread(ctx, t.id);
      break; // one send per mailbox per tick
    }
  }
  return res;
}

async function handleSendError(ctx: Ctx, mb: Mailbox, m: typeof messages.$inferSelect, to: string, err: unknown): Promise<void> {
  const now = ctx.clock.now();
  const back = (extra: Partial<typeof messages.$inferInsert> = {}) =>
    ctx.db.update(messages).set({ status: "scheduled", claimedAt: null, lastError: String((err as Error).message).slice(0, 500), ...extra }).where(eq(messages.id, m.id));

  if (!(err instanceof SendError)) {
    // Unknown failure inside the provider call: delivery state is uncertain.
    await ctx.db.update(messages).set({ status: "unknown", lastError: String((err as Error)?.message ?? err).slice(0, 500) }).where(eq(messages.id, m.id));
    await recordEvent(ctx.db, "send_unknown", { messageId: m.id, mailboxId: mb.id, at: now });
    await ctx.alerts.notify({ level: "critical", key: `send_unknown:${m.id}`, title: "Send outcome unknown", body: `${mb.email} -> ${to}: ${(err as Error)?.message}` });
    return;
  }
  switch (err.kind) {
    case "auth":
      await back();
      await pauseMailbox(ctx, mb.id, `authentication failed: ${err.message}`);
      return;
    case "throttle":
      await back();
      await pauseMailbox(ctx, mb.id, `provider throttling: ${err.message}`);
      return;
    case "transient":
      if (m.sendAttempts >= MAX_ATTEMPTS) {
        await ctx.db.update(messages).set({ status: "failed", lastError: err.message }).where(eq(messages.id, m.id));
        await recordEvent(ctx.db, "send_failed", { messageId: m.id, mailboxId: mb.id, data: { error: err.message }, at: now });
        await ctx.alerts.notify({ level: "warn", key: `send_failed:${m.id}`, title: "Send failed after retries", body: `${mb.email} -> ${to}: ${err.message}` });
      } else {
        await back({ scheduledFor: new Date(now.getTime() + 5 * MINUTE * m.sendAttempts) });
      }
      return;
    case "recipient":
      // Rejected at SMTP time: a hard bounce in all but name.
      await ctx.db.update(messages).set({ status: "failed", lastError: err.message }).where(eq(messages.id, m.id));
      await recordEvent(ctx.db, "bounced_hard", { messageId: m.id, mailboxId: mb.id, contactId: m.contactId, data: { stage: "smtp", error: err.message }, at: now });
      await suppress(ctx.db, { email: to }, "hard bounce (rejected at send)", "sequencer");
      return;
    case "permanent":
      await ctx.db.update(messages).set({ status: "failed", lastError: err.message }).where(eq(messages.id, m.id));
      await recordEvent(ctx.db, "send_failed", { messageId: m.id, mailboxId: mb.id, data: { error: err.message }, at: now });
      await ctx.alerts.notify({ level: "warn", key: `send_failed:${m.id}`, title: "Send failed", body: `${mb.email} -> ${to}: ${err.message}` });
  }
}
