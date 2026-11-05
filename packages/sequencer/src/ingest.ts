import {
  contacts,
  domainOf,
  events,
  mailboxes,
  messages,
  normalizeEmail,
  pauseMailbox,
  recordEvent,
  isFreeMailDomain,
  replies,
  stripQuotedHistory,
  suppress,
  threads,
  type Ctx,
} from "@opengtm/core";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { isAutoReply, isBounce, parseBounce } from "./bounces";
import type { InboundMessage, MailReader } from "./readers";
import { SendError } from "./transports";

type Mailbox = typeof mailboxes.$inferSelect;

export interface IngestStats {
  replies: number;
  bouncesHard: number;
  bouncesSoft: number;
  unmatched: number;
}

const SOFT_BOUNCES_TO_SUPPRESS = 3;

/** Find which of our sent messages an inbound email relates to: headers first, then sender address. */
async function matchMessage(ctx: Ctx, mb: Mailbox, ids: string[], fromEmail: string | null, opts: { colleague?: boolean } = {}) {
  const clean = ids.filter(Boolean);
  if (clean.length) {
    const [hit] = await ctx.db.select().from(messages).where(inArray(messages.rfcMessageId, clean)).orderBy(desc(messages.stepNumber)).limit(1);
    if (hit) return hit;
  }
  if (fromEmail) {
    const [hit] = await ctx.db
      .select({ m: messages })
      .from(messages)
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .where(and(eq(sql`lower(${contacts.email})`, normalizeEmail(fromEmail)), eq(messages.mailboxId, mb.id), eq(messages.status, "sent")))
      .orderBy(desc(messages.sentAt))
      .limit(1);
    if (hit) return hit.m;
    // A colleague answering for them (assistant, office manager): same company domain, our latest email from this mailbox.
    const domain = domainOf(fromEmail);
    if (opts.colleague && domain && !isFreeMailDomain(domain)) {
      const [colleague] = await ctx.db
        .select({ m: messages })
        .from(messages)
        .innerJoin(contacts, eq(contacts.id, messages.contactId))
        .where(and(sql`lower(${contacts.email}) like ${`%@${domain}`}`, eq(messages.mailboxId, mb.id), eq(messages.status, "sent")))
        .orderBy(desc(messages.sentAt))
        .limit(1);
      if (colleague) return colleague.m;
    }
  }
  return null;
}

async function handleBounce(ctx: Ctx, mb: Mailbox, m: InboundMessage, stats: IngestStats) {
  const b = parseBounce(m);
  const original = await matchMessage(ctx, mb, [b.originalMessageId ?? ""], b.recipient);
  const [known] = !original && b.recipient ? await ctx.db.select().from(contacts).where(eq(sql`lower(${contacts.email})`, normalizeEmail(b.recipient))).limit(1) : [];
  const contactId = original?.contactId ?? known?.id ?? null;
  const [contact] = contactId ? await ctx.db.select().from(contacts).where(eq(contacts.id, contactId)) : [];
  // Not one of our emails or leads: a bounce of warm-up mail the vendor's pool sent through this
  // mailbox. Kept for the record (health doesn't count it) but nobody is suppressed for it.
  const email = contact?.email ?? null;
  const type = b.kind === "hard" ? "bounced_hard" : "bounced_soft";
  await recordEvent(ctx.db, type, {
    mailboxId: original?.mailboxId ?? mb.id,
    messageId: original?.id,
    threadId: original?.threadId,
    contactId,
    data: { status: b.status, diagnostic: b.diagnostic, recipient: b.recipient },
    at: ctx.clock.now(),
  });
  if (b.kind === "hard") {
    stats.bouncesHard++;
    if (email) await suppress(ctx.db, { email }, `hard bounce ${b.status ?? ""}`.trim(), "dsn");
    if (contactId) await ctx.db.update(contacts).set({ status: "bounced" }).where(eq(contacts.id, contactId));
  } else {
    stats.bouncesSoft++;
    if (contactId) {
      const [n] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(events)
        .where(and(eq(events.type, "bounced_soft"), eq(events.contactId, contactId)));
      if ((n?.n ?? 0) >= SOFT_BOUNCES_TO_SUPPRESS && email) await suppress(ctx.db, { email }, "repeated soft bounces", "dsn");
    }
  }
}

async function handleReply(ctx: Ctx, mb: Mailbox, m: InboundMessage, stats: IngestStats) {
  const original = await matchMessage(ctx, mb, [m.inReplyTo ?? "", ...m.references], m.from, { colleague: true });
  if (!original) {
    stats.unmatched++;
    return;
  }
  const auto = isAutoReply(m);
  const inserted = await ctx.db
    .insert(replies)
    .values({
      threadId: original.threadId,
      messageId: original.id,
      contactId: original.contactId,
      mailboxId: mb.id,
      fromEmail: normalizeEmail(m.from),
      subject: m.subject.slice(0, 500),
      body: stripQuoted(m.text).slice(0, 20_000),
      receivedAt: m.date,
      rfcMessageId: m.rfcMessageId ?? `${mb.id}:${m.uid}`,
      classifiedBy: auto ? "headers:auto_reply" : null,
    })
    .onConflictDoNothing()
    .returning({ id: replies.id });
  if (!inserted.length) return; // already ingested
  stats.replies++;
  await recordEvent(ctx.db, "replied", { messageId: original.id, threadId: original.threadId, contactId: original.contactId, mailboxId: mb.id, data: { auto }, at: ctx.clock.now() });

  // Any human reply stops the sequence immediately; classification decides what happens next.
  if (!auto) {
    await ctx.db.update(threads).set({ status: "stopped", stopReason: "replied" }).where(and(eq(threads.id, original.threadId), inArray(threads.status, ["drafting", "active"])));
    await ctx.db
      .update(messages)
      .set({ status: "cancelled" })
      .where(and(eq(messages.threadId, original.threadId), eq(messages.kind, "sequence"), inArray(messages.status, ["draft", "scheduled"])));
    await ctx.db.update(contacts).set({ status: "replied" }).where(and(eq(contacts.id, original.contactId), ne(contacts.status, "suppressed")));
  }
}

/** Remove quoted history so classification and storage only see the new text. */
export const stripQuoted = stripQuotedHistory;

/** Poll each mailbox, store replies, process bounces. Poll every 2-5 minutes. */
export async function runIngest(ctx: Ctx, readerFor: (mb: Mailbox) => MailReader): Promise<IngestStats> {
  const stats: IngestStats = { replies: 0, bouncesHard: 0, bouncesSoft: 0, unmatched: 0 };
  const mbs = await ctx.db.select().from(mailboxes).where(ne(mailboxes.status, "retired"));
  const own = new Set(mbs.map((m) => m.email.toLowerCase()));
  for (const mb of mbs) {
    let batch;
    try {
      batch = await readerFor(mb).fetchNew(mb.ingestCursor);
    } catch (err) {
      if (err instanceof SendError && err.kind === "auth") await pauseMailbox(ctx, mb.id, `inbox auth failed: ${err.message}`);
      else ctx.log.warn({ err: (err as Error).message, mailbox: mb.email }, "ingest failed; will retry");
      continue;
    }
    for (const m of batch.messages) {
      if (own.has(m.from.toLowerCase())) continue; // our own sent copies / seed tests
      try {
        if (isBounce(m)) await handleBounce(ctx, mb, m, stats);
        else await handleReply(ctx, mb, m, stats);
      } catch (err) {
        ctx.log.error({ err, uid: m.uid, mailbox: mb.email }, "failed to process inbound message");
      }
    }
    await ctx.db.update(mailboxes).set({ ingestCursor: batch.cursor, lastIngestAt: ctx.clock.now() }).where(eq(mailboxes.id, mb.id));
  }
  return stats;
}
