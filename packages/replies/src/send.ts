import {
  audit,
  companies,
  contacts,
  isKillSwitchOn,
  isSuppressed,
  mailboxes,
  meetings,
  messages,
  recordEvent,
  replies,
  type Ctx,
} from "@opengtm/core";
import { listUnsubscribe, newMessageId, type MailTransport } from "@opengtm/sequencer";
import { checkCompliance, composeBody, emailHtml, hasFooter, SIGN_OFF } from "@opengtm/writer";
import { and, asc, eq, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { CRMSink } from "./crm";

export class ReplySendError extends Error {}

/**
 * One-click "approve and send" for a drafted reply. Sends right away from the
 * thread's mailbox, threaded under the prospect's message.
 */
export async function approveAndSendReply(
  ctx: Ctx,
  replyId: string,
  actor: string,
  deps: { transportFor: (mb: typeof mailboxes.$inferSelect) => MailTransport; publicBaseUrl?: string; unsubscribeSecret?: string },
  edit?: { body?: string; cc?: string[] },
): Promise<string> {
  if (await isKillSwitchOn(ctx.db)) throw new ReplySendError("kill switch is on");
  const [r] = await ctx.db.select().from(replies).where(eq(replies.id, replyId));
  if (!r || !r.threadId || !r.contactId) throw new ReplySendError("reply not found");
  if (r.draftState === "sent") throw new ReplySendError("already sent");
  const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, r.contactId));
  const [mb] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, r.mailboxId));
  const [company] = contact ? await ctx.db.select({ domain: companies.domain }).from(companies).where(eq(companies.id, contact.companyId)) : [];
  if (!contact || !mb) throw new ReplySendError("missing contact or mailbox");
  // A reply typed in the inbox has no signature yet; add the same signature + footer as every email.
  // A typed reply that ends with its own "Best, <name>" would get a second one with the signature.
  const typed = edit?.body?.trim().replace(new RegExp(`\\n+${SIGN_OFF}\\s*\\n+[^\\n]{1,40}\\s*$`), "").trim();
  const body = typed ? (hasFooter(typed) ? typed : composeBody(typed, ctx.config, { name: mb.senderName, title: mb.senderTitle, phone: mb.senderPhone })) : r.draftBody;
  if (!body) throw new ReplySendError("no draft to send");
  if (await isSuppressed(ctx.db, contact.email, company?.domain)) throw new ReplySendError("contact is suppressed");
  const compliance = checkCompliance(body, ctx.config, { name: mb.senderName, title: mb.senderTitle, phone: mb.senderPhone });
  if (compliance.length) throw new ReplySendError(`compliance: ${compliance.map((i) => i.message).join("; ")}`);

  const chain = await ctx.db
    .select({ rfc: messages.rfcMessageId })
    .from(messages)
    .where(and(eq(messages.threadId, r.threadId), eq(messages.status, "sent"), isNotNull(messages.rfcMessageId)))
    .orderBy(asc(messages.sentAt));
  const refs = [...chain.map((c) => c.rfc!), ...(r.rfcMessageId && !r.rfcMessageId.includes(":") ? [r.rfcMessageId] : [])];
  const subject = /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`;
  const rfc = newMessageId(mb.email);
  const [{ n }] = (await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.threadId, r.threadId), eq(messages.kind, "reply")))) as [{ n: number }];
  const now = ctx.clock.now();

  // Lock first (same idempotency rule as the sequencer).
  const [row] = await ctx.db
    .insert(messages)
    .values({
      threadId: r.threadId,
      contactId: contact.id,
      kind: "reply",
      stepNumber: 100 + n,
      subject,
      body,
      approvalState: "approved",
      approvedBy: actor,
      approvedAt: now,
      status: "sending",
      claimedAt: now,
      mailboxId: mb.id,
      rfcMessageId: rfc,
      inReplyTo: refs.at(-1) ?? null,
      references: refs.join(" ") || null,
      sendAttempts: 1,
    })
    .returning();
  try {
    await deps.transportFor(mb).send({
      from: { name: mb.senderName, address: mb.email },
      replyTo: mb.email,
      to: contact.email,
      cc: (edit?.cc ?? ctx.config.business.outreach.reply_cc).filter((a) => a.toLowerCase() !== contact.email.toLowerCase()),
      subject,
      text: body,
      ...(() => {
        const rich = emailHtml(body, { name: mb.senderName, title: mb.senderTitle, phone: mb.senderPhone }, ctx.config);
        return rich ? { html: rich.html, inline: rich.inline } : {};
      })(),
      messageId: rfc,
      inReplyTo: refs.at(-1),
      references: refs.length ? refs : undefined,
      listUnsubscribe: listUnsubscribe({ mailbox: mb.email, contactId: contact.id, baseUrl: deps.publicBaseUrl, secret: deps.unsubscribeSecret }),
    });
  } catch (err) {
    await ctx.db.update(messages).set({ status: "failed", lastError: (err as Error).message }).where(eq(messages.id, row!.id));
    throw new ReplySendError(`send failed: ${(err as Error).message}`);
  }
  await ctx.db.update(messages).set({ status: "sent", sentAt: now }).where(eq(messages.id, row!.id));
  await ctx.db.update(replies).set({ draftState: "sent", draftBody: body, handled: true }).where(eq(replies.id, replyId));
  // One conversation, one answer: earlier replies in this thread are answered by this one too (their unsent
  // drafts, and auto-sends, are dropped so nothing else goes out).
  await ctx.db
    .update(replies)
    .set({ handled: true, autoSendAt: null, draftState: sql`case when ${replies.draftState} = 'pending' then 'rejected' else ${replies.draftState} end` })
    .where(and(eq(replies.threadId, r.threadId), ne(replies.id, replyId), lt(replies.receivedAt, r.receivedAt)));
  await ctx.db.update(meetings).set({ nextStep: "Reply sent; waiting for them to book", updatedAt: now }).where(eq(meetings.replyId, replyId));
  await recordEvent(ctx.db, "sent", { messageId: row!.id, threadId: r.threadId, contactId: contact.id, mailboxId: mb.id, data: { kind: "reply" }, at: now });
  await audit(ctx.db, actor, "reply.send", "replies", replyId);
  return row!.id;
}

export async function rejectReplyDraft(ctx: Ctx, replyId: string, actor: string): Promise<void> {
  await ctx.db.update(replies).set({ draftState: "rejected" }).where(eq(replies.id, replyId));
  await audit(ctx.db, actor, "reply.reject_draft", "replies", replyId);
}

/** Record a booked meeting (one click from the inbox) and sync it to the CRM sink. */
export async function bookMeeting(ctx: Ctx, meetingId: string, at: Date, actor: string, crm: CRMSink): Promise<void> {
  const [m] = await ctx.db.update(meetings).set({ stage: "booked", bookedAt: at, nextStep: "Hold the demo", updatedAt: ctx.clock.now() }).where(eq(meetings.id, meetingId)).returning();
  if (!m) throw new Error("meeting not found");
  await audit(ctx.db, actor, "meeting.book", "meetings", meetingId, { at: at.toISOString() });
  await syncMeeting(ctx, meetingId, crm);
}

export async function setMeetingStage(ctx: Ctx, meetingId: string, stage: "held" | "won" | "lost", actor: string, crm: CRMSink): Promise<void> {
  await ctx.db.update(meetings).set({ stage, updatedAt: ctx.clock.now() }).where(eq(meetings.id, meetingId));
  await audit(ctx.db, actor, `meeting.${stage}`, "meetings", meetingId);
  await syncMeeting(ctx, meetingId, crm);
}

export async function syncMeeting(ctx: Ctx, meetingId: string, crm: CRMSink): Promise<void> {
  const [row] = await ctx.db
    .select({ m: meetings, c: contacts, co: companies })
    .from(meetings)
    .innerJoin(contacts, eq(contacts.id, meetings.contactId))
    .innerJoin(companies, eq(companies.id, meetings.companyId))
    .where(eq(meetings.id, meetingId));
  if (!row) return;
  try {
    await crm.upsert({
      meetingId,
      stage: row.m.stage,
      contact: { name: [row.c.firstName, row.c.lastName].filter(Boolean).join(" "), email: row.c.email, title: row.c.title },
      company: { name: row.co.name, domain: row.co.domain, state: row.co.state },
      whyHot: row.m.whyHot,
      nextStep: row.m.nextStep,
      bookedAt: row.m.bookedAt?.toISOString() ?? null,
    });
    await ctx.db.update(meetings).set({ crmSyncedAt: ctx.clock.now() }).where(eq(meetings.id, meetingId));
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, "CRM sync failed; will retry on next change");
  }
}
