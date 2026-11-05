import {
  companies,
  contacts,
  DAY,
  domainOf,
  isFreeMailDomain,
  isRoleAddress,
  isSuppressed,
  isValidEmailSyntax,
  meetings,
  newReplyText,
  normalizeEmail,
  recordEvent,
  replies,
  suppress,
  threads,
  type Ctx,
} from "@opengtm/core";
import { and, desc, eq, gte, isNull, notInArray } from "drizzle-orm";
import { classifyReply, withDefaults, type Classification } from "./classify";
import { loadConversation } from "./conversation";
import { preClassify } from "./rules";
import type { CRMSink } from "./crm";
import { prepareBrief } from "./brief";
import { draftReply } from "./draft";
import { syncMeeting } from "./send";

export interface ReplyDeps {
  crm: CRMSink;
}

async function addReferral(ctx: Ctx, replyRow: typeof replies.$inferSelect, cls: Classification, companyId: string, segmentId: string | null): Promise<string> {
  const fromBody = (replyRow.body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map(normalizeEmail).filter((e) => e !== replyRow.fromEmail);
  const email = normalizeEmail(cls.referral?.email ?? fromBody[0] ?? "");
  if (!email || !isValidEmailSyntax(email)) return "no_referral_found";
  if (await isSuppressed(ctx.db, email)) return "referral_suppressed";

  let targetCompany = companyId;
  const [own] = await ctx.db.select().from(companies).where(eq(companies.id, companyId));
  if (own && domainOf(email) !== own.domain) {
    const domain = domainOf(email);
    const [created] = await ctx.db
      .insert(companies)
      .values({ domain, name: domain, website: `https://${domain}`, source: "referral", sourceRef: `reply:${replyRow.id}`, segmentId, country: "US" })
      .onConflictDoNothing()
      .returning({ id: companies.id });
    const [existing] = created ? [created] : await ctx.db.select({ id: companies.id }).from(companies).where(eq(companies.domain, domain));
    targetCompany = existing!.id;
  }
  const [first, ...rest] = (cls.referral?.name ?? "").split(/\s+/).filter(Boolean);
  const inserted = await ctx.db
    .insert(contacts)
    .values({
      companyId: targetCompany,
      email,
      firstName: first ?? null,
      lastName: rest.join(" ") || null,
      title: cls.referral?.title ?? null,
      isRoleAddress: isRoleAddress(email),
      source: "referral",
      sourceUrl: `reply:${replyRow.id}`,
    })
    .onConflictDoNothing()
    .returning({ id: contacts.id });
  return inserted.length ? "referral_added" : "referral_exists";
}

/** Machine notices nobody needs an email about. */
const QUIET_LABELS = new Set<Classification["label"]>(["out_of_office", "bounce"]);
const personName = (c: typeof contacts.$inferSelect) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email;
const quoteOf = (body: string) => {
  const t = (newReplyText(body) || body).trim().replace(/\n{3,}/g, "\n\n");
  return t.length > 600 ? `${t.slice(0, 600)}…` : t;
};

const NEVER_HOT = new Set<Classification["label"]>(["unsubscribe", "hostile", "bounce", "out_of_office", "recipient_gone", "email_changed", "not_now"]);

function summaryWithQuestions(summary: string, questions: string[]): string {
  const missing = questions.filter((q) => !summary.toLowerCase().includes(q.toLowerCase().slice(0, 20)));
  return missing.length ? `${summary} Asks: ${missing.map((q) => (q.endsWith("?") ? q : `${q}?`)).join(" ")}` : summary;
}

/** Apply the action table from CLAUDE.md section 10. Returns the action taken. */
/** `quiet`: re-handling an old reply, so teammates aren't emailed about it again. */
export async function applyReplyActions(ctx: Ctx, replyId: string, raw: Classification, deps: ReplyDeps, opts: { quiet?: boolean } = {}): Promise<string> {
  const cls = withDefaults(raw);
  const now = ctx.clock.now();
  const [r] = await ctx.db.select().from(replies).where(eq(replies.id, replyId));
  if (!r) return "missing";
  const [t] = r.threadId ? await ctx.db.select().from(threads).where(eq(threads.id, r.threadId)) : [];
  const [contact] = r.contactId ? await ctx.db.select().from(contacts).where(eq(contacts.id, r.contactId)) : [];
  const [company] = t ? await ctx.db.select().from(companies).where(eq(companies.id, t.companyId)) : [];
  let action = "none";

  await ctx.db
    .update(replies)
    .set({ label: cls.label, confidence: cls.confidence, classifiedBy: cls.by, summary: summaryWithQuestions(cls.summary, cls.questions), oooUntil: cls.oooUntil })
    .where(eq(replies.id, replyId));

  // Anything that reads like a buyer is a hot lead, whatever its label.
  const hot = cls.hot && !NEVER_HOT.has(cls.label);
  switch (hot ? "hot" : cls.label) {
    case "hot":
    case "interested":
    case "question": {
      await ctx.db.update(replies).set({ hot: true }).where(eq(replies.id, replyId));
      if (contact && company) {
        const [existing] = await ctx.db.select().from(meetings).where(eq(meetings.contactId, contact.id)).orderBy(desc(meetings.createdAt)).limit(1);
        const meetingId =
          existing?.id ??
          (await ctx.db
            .insert(meetings)
            .values({ contactId: contact.id, companyId: company.id, threadId: t?.id ?? null, replyId, whyHot: cls.summary, nextStep: cls.nextStep || "Send the free preview and offer a 15-minute demo" })
            .returning({ id: meetings.id }))[0]!.id;
        await syncMeeting(ctx, meetingId, deps.crm);
        // Someone already a hot lead who writes again is the same conversation, not a new hot lead (2026-11-04).
        await ctx.alerts.notify({
          level: "warn",
          key: `hot_lead:${replyId}`,
          title: existing ? `${personName(contact)} at ${company.name} replied again` : `Hot lead: ${personName(contact)} at ${company.name}`,
          body: `${cls.summary}\n\nThey wrote:\n"${quoteOf(r.body)}"\n\nA reply is drafted and waiting for you to send.`,
        });
      }
      await draftReply(ctx, replyId);
      // Demo prep on the hot-lead record (Lead data page); a failure here never holds up the reply.
      if (contact && company) {
        const [hl] = await ctx.db.select({ id: meetings.id, brief: meetings.brief }).from(meetings).where(eq(meetings.contactId, contact.id)).orderBy(desc(meetings.createdAt)).limit(1);
        if (hl && !hl.brief) await prepareBrief(ctx, hl.id).catch((err) => ctx.log.warn({ err, meetingId: hl.id }, "demo prep brief failed"));
      }
      action = "hot_lead_drafted";
      break;
    }
    case "objection":
      if (!cls.replyNeeded) {
        // A bare "no thanks": nothing to answer, and they are never emailed again by this engine.
        if (contact) await ctx.db.update(contacts).set({ status: "dropped", dropReason: "not interested", updatedAt: now }).where(eq(contacts.id, contact.id));
        action = "not_interested";
        break;
      }
      await draftReply(ctx, replyId);
      action = "objection_drafted";
      break;
    case "not_now":
      if (contact) {
        await ctx.db
          .update(contacts)
          .set({ status: "snoozed", retouchAt: new Date(now.getTime() + ctx.config.engine.replies.retouch_days * DAY), updatedAt: now })
          .where(eq(contacts.id, contact.id));
      }
      action = "snoozed";
      break;
    case "wrong_person":
    case "referral":
      action = company ? await addReferral(ctx, r, cls, company.id, company.segmentId) : "no_company";
      break;
    case "email_changed": {
      // Same person, new address (often a new company): drop the old address and add the new one as a lead.
      const fullName = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null : null;
      const moved: Classification = { ...cls, referral: { name: fullName, email: cls.referral?.email ?? null, title: contact?.title ?? null } };
      action = company ? await addReferral(ctx, r, moved, company.id, company.segmentId) : "no_company";
      if (action === "referral_added" || action === "referral_exists") action = `email_changed:${normalizeEmail(moved.referral!.email ?? "")}`;
      if (contact) {
        await ctx.db
          .update(contacts)
          .set({ status: "dropped", dropReason: `moved to ${moved.referral?.email ?? "a new address"}`, updatedAt: now })
          .where(eq(contacts.id, contact.id));
        // The old address is dead: suppressing it also stops follow-ups already queued (an auto-reply doesn't stop the thread on arrival).
        await suppress(ctx.db, { email: contact.email }, `moved to ${moved.referral?.email ?? "a new address"}`, "reply");
      }
      break;
    }
    case "recipient_gone":
      if (contact) {
        await ctx.db.update(contacts).set({ status: "dropped", dropReason: "no longer at the company", updatedAt: now }).where(eq(contacts.id, contact.id));
        // A dead mailbox or a person who left: never email this address again, including follow-ups already queued.
        await suppress(ctx.db, { email: contact.email }, "no longer at the company", "reply");
      }
      action = "recipient_gone";
      break;
    case "out_of_office":
      if (t) {
        const until = new Date((cls.oooUntil ?? new Date(now.getTime() + 7 * DAY)).getTime() + DAY);
        await ctx.db.update(threads).set({ pausedUntil: until }).where(eq(threads.id, t.id));
        // If a real reply arrives later it will stop the thread as usual.
        action = `paused_until:${until.toISOString().slice(0, 10)}`;
      }
      break;
    case "unsubscribe":
    case "hostile":
      if (contact) {
        await suppress(ctx.db, { email: contact.email }, cls.label, "reply");
        // The whole company is its website domain; a personal address (gmail.com) is never treated as a company.
        const companyDomain = company?.domain ?? domainOf(contact.email);
        if (cls.removeWholeCompany && !isFreeMailDomain(companyDomain)) await suppress(ctx.db, { domain: companyDomain }, `${cls.label}: whole company`, "reply");
        await recordEvent(ctx.db, cls.label === "hostile" ? "complaint" : "unsub", { contactId: contact.id, mailboxId: r.mailboxId, threadId: r.threadId, data: { replyId }, at: now });
      }
      action = cls.removeWholeCompany ? "suppressed_firm" : "suppressed";
      break;
    case "bounce":
      if (contact) {
        await suppress(ctx.db, { email: contact.email }, "bounce (from reply)", "reply");
        await recordEvent(ctx.db, "bounced_hard", { contactId: contact.id, mailboxId: r.mailboxId, messageId: r.messageId, data: { via: "reply_classifier" }, at: now });
      }
      action = "suppressed_bounce";
      break;
    case "other":
      // Unclear ("who is this?"): a human decides, with a short draft ready when an answer makes sense.
      if (cls.replyNeeded) await draftReply(ctx, replyId);
      action = "needs_human";
      break;
  }
  await ctx.db.update(replies).set({ actionTaken: action, handled: cls.label !== "other" }).where(eq(replies.id, replyId));
  // "Every reply" email for teammates who want it (hot leads already got their own alert).
  if (!hot && contact && !QUIET_LABELS.has(cls.label) && !opts.quiet) {
    await ctx.alerts.notify({
      level: "info",
      key: `reply:${replyId}`,
      title: `${personName(contact)}${company ? ` at ${company.name}` : ""} replied`,
      body: `${cls.summary}\n\nThey wrote:\n"${quoteOf(r.body)}"`,
    });
  }
  return action;
}

/** Classify and act on every reply that has not been labeled yet, reading each in the context of its thread. */
export async function runReplies(ctx: Ctx, deps: ReplyDeps, limit = 50): Promise<{ processed: number }> {
  const rows = await ctx.db.select().from(replies).where(isNull(replies.label)).orderBy(replies.receivedAt).limit(limit);
  for (const r of rows) {
    const convo = await loadConversation(ctx, r.id);
    const [t] = r.threadId ? await ctx.db.select({ companyId: threads.companyId }).from(threads).where(eq(threads.id, r.threadId)) : [];
    const cls = await classifyReply(
      ctx,
      { subject: r.subject, body: r.body, classifiedBy: r.classifiedBy, fromEmail: r.fromEmail, ourLastEmail: convo?.ourLast, conversation: convo?.text, who: convo?.who },
      { companyId: t?.companyId },
    );
    await applyReplyActions(ctx, r.id, cls, deps);
  }
  await recheckAwayNotices(ctx, deps);
  return { processed: rows.length };
}

/**
 * Away notices from the last 45 days whose sender is still being emailed are read again with the current rules:
 * one that turns out to say the mailbox is dead or the person moved is handled as such (stopping the follow-ups a
 * mere pause would let through next week). Rules only, no model call; handled ones drop out of the next check.
 */
export async function recheckAwayNotices(ctx: Ctx, deps: ReplyDeps): Promise<{ restopped: number }> {
  const since = new Date(ctx.clock.now().getTime() - 45 * DAY);
  const rows = await ctx.db
    .select({ r: replies })
    .from(replies)
    .innerJoin(contacts, eq(contacts.id, replies.contactId))
    .where(and(eq(replies.label, "out_of_office"), gte(replies.receivedAt, since), notInArray(contacts.status, ["suppressed", "dropped"])))
    .limit(500);
  let restopped = 0;
  for (const { r } of rows) {
    const rule = preClassify({ subject: r.subject, body: r.body, classifiedBy: r.classifiedBy, fromEmail: r.fromEmail }, ctx.clock.now());
    if (rule?.label !== "recipient_gone" && rule?.label !== "email_changed") continue;
    const cls = await classifyReply(ctx, { subject: r.subject, body: r.body, classifiedBy: r.classifiedBy, fromEmail: r.fromEmail }, {});
    await applyReplyActions(ctx, r.id, cls, deps, { quiet: true });
    restopped++;
  }
  return { restopped };
}
