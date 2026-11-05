import { companies, contacts, facts, mailboxes, messages, newReplyText, replies, threads, type Ctx } from "@opengtm/core";
import { stripFooter } from "@opengtm/writer";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

export interface Conversation {
  /** Every email so far, oldest first, as "Us (Alex), Oct 21: ..." / "Them, Oct 22: ...". */
  text: string;
  /** Body of the last email we sent, signature removed. */
  ourLast: string;
  /** "Jane Doe, Owner at Doe Landscaping (landscaping, TX)". */
  who: string;
  /** What research found about the company, for answering "is this a fit for us?". */
  companyFacts: string[];
  firstName: string;
  companyName: string;
  senderName: string;
  senderTitle: string;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const ours = (body: string) => stripFooter(body);

/** The thread a reply belongs to, in order, so the classifier and the drafter read it in context. */
export async function loadConversation(ctx: Ctx, replyId: string): Promise<Conversation | null> {
  const [r] = await ctx.db.select().from(replies).where(eq(replies.id, replyId));
  if (!r?.threadId) return null;
  const [t] = await ctx.db.select().from(threads).where(eq(threads.id, r.threadId));
  if (!t) return null;
  const [contact] = r.contactId ? await ctx.db.select().from(contacts).where(eq(contacts.id, r.contactId)) : [];
  const [company] = await ctx.db.select().from(companies).where(eq(companies.id, t.companyId));
  const [mb] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, r.mailboxId));
  const sent = await ctx.db
    .select({ body: messages.body, at: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.threadId, t.id), inArray(messages.status, ["sent"])))
    .orderBy(asc(messages.sentAt));
  const earlier = await ctx.db
    .select({ id: replies.id, body: replies.body, at: replies.receivedAt })
    .from(replies)
    .where(eq(replies.threadId, t.id))
    .orderBy(asc(replies.receivedAt));
  const sender = mb?.senderName ?? "us";
  const items = [
    ...sent.map((m) => ({ at: m.at ?? new Date(0), line: `Us (${sender}), ${day(m.at)}:\n${ours(m.body)}` })),
    ...earlier.filter((e) => e.id !== r.id).map((e) => ({ at: e.at, line: `Them, ${day(e.at)}:\n${newReplyText(e.body) || e.body.trim()}` })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const fs = company
    ? await ctx.db.select({ text: facts.text }).from(facts).where(eq(facts.companyId, company.id)).orderBy(desc(facts.fetchedAt)).limit(6)
    : [];
  const name = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") : "";
  const companyLabel = company ? `${company.name}${company.focusAreas?.length ? ` (${company.focusAreas.slice(0, 3).join(", ")}${company.state ? `, ${company.state}` : ""})` : company.state ? ` (${company.state})` : ""}` : "their company";
  return {
    text: items.map((i) => i.line).join("\n\n---\n\n"),
    ourLast: sent.length ? ours(sent.at(-1)!.body) : "",
    who: [name || r.fromEmail, contact?.title].filter(Boolean).join(", ") + ` at ${companyLabel}`,
    companyFacts: fs.map((f) => f.text),
    firstName: contact?.firstName ?? "",
    companyName: company?.name ?? "",
    senderName: mb?.senderName ?? "",
    senderTitle: mb?.senderTitle ?? "",
  };
}
