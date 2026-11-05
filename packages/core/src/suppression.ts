import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { companies, contacts, messages, suppression, threads } from "./db/schema";
import { recordEvent } from "./events";
import { domainOf, isFreeMailDomain, normalizeDomain, normalizeEmail } from "./text";

/** "mail.smithlaw.com" -> ["mail.smithlaw.com", "smithlaw.com"]: a company's block covers its subdomains. Never a bare TLD. */
export function domainAndParents(domain: string): string[] {
  const parts = normalizeDomain(domain).split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join("."));
  return out;
}

/** The address itself, plus the same mailbox without a "+tag" (jane+news@company.com is jane@company.com). */
function emailKeys(email: string): string[] {
  const e = normalizeEmail(email);
  const [local = "", domain = ""] = e.split("@");
  const base = local.split("+")[0]!;
  return base && base !== local ? [e, `${base}@${domain}`] : [e];
}

/**
 * True when this person must not be emailed: their address (with or without a +tag), their email domain or
 * any parent of it, or their company's website domain is on the list. The company's domain matters when they use a
 * personal address (jane@gmail.com at smithlaw.com): a whole-company block still reaches them.
 */
export async function isSuppressed(db: Db, email: string, companyDomain?: string | null): Promise<boolean> {
  const domains = [...domainAndParents(domainOf(email)), ...(companyDomain ? domainAndParents(companyDomain) : [])];
  const rows = await db
    .select({ id: suppression.id })
    .from(suppression)
    .where(or(inArray(suppression.email, emailKeys(email)), domains.length ? inArray(suppression.domain, domains) : undefined))
    .limit(1);
  return rows.length > 0;
}

export async function isDomainSuppressed(db: Db, domain: string): Promise<boolean> {
  const domains = domainAndParents(domain);
  if (!domains.length) return false;
  const rows = await db.select({ id: suppression.id }).from(suppression).where(inArray(suppression.domain, domains)).limit(1);
  return rows.length > 0;
}

/**
 * Permanently suppress an email or a whole domain, and stop every live sequence
 * that would reach it. Suppression is never removed automatically. A whole-domain
 * block reaches people at that domain or its subdomains and anyone whose company's
 * website is that domain, whatever address they use.
 */
export async function suppress(
  db: Db,
  target: { email?: string; domain?: string },
  reason: string,
  source: string,
): Promise<void> {
  const email = target.email ? normalizeEmail(target.email) : undefined;
  const domain = target.domain ? normalizeDomain(target.domain) : undefined;
  if (!email && !domain) throw new Error("suppress: email or domain required");
  if (domain && isFreeMailDomain(domain)) throw new Error(`suppress: ${domain} is a public mailbox provider, not a company; suppress the address instead`);
  if (email) {
    await db.insert(suppression).values({ email, reason, source }).onConflictDoNothing();
  }
  if (domain) {
    await db.insert(suppression).values({ domain, reason, source }).onConflictDoNothing();
  }

  const affected = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      email
        ? inArray(sql`lower(${contacts.email})`, emailKeys(email))
        : or(
            sql`split_part(lower(${contacts.email}), '@', 2) = ${domain}`,
            sql`split_part(lower(${contacts.email}), '@', 2) like ${`%.${domain}`}`,
            inArray(contacts.companyId, db.select({ id: companies.id }).from(companies).where(eq(companies.domain, domain!))),
          ),
    );
  const ids = affected.map((c) => c.id);
  if (ids.length === 0) return;

  await db
    .update(contacts)
    .set({ status: "suppressed", updatedAt: new Date() })
    .where(inArray(contacts.id, ids));
  const live = await db
    .update(threads)
    .set({ status: "stopped", stopReason: `suppressed: ${reason}` })
    .where(and(inArray(threads.contactId, ids), inArray(threads.status, ["drafting", "active"])))
    .returning({ id: threads.id });
  if (live.length) {
    await db
      .update(messages)
      .set({ status: "cancelled" })
      .where(and(inArray(messages.threadId, live.map((t) => t.id)), inArray(messages.status, ["draft", "scheduled"])));
  }
  for (const id of ids) {
    await recordEvent(db, "suppressed", { contactId: id, data: { reason, source, email, domain } });
  }
}

export interface SuppressionLeak {
  messageId: string;
  to: string;
  sentAt: Date;
  suppressedAt: Date;
  entry: string;
}

/**
 * The standing proof that the list works: every email we sent to someone after they were on the
 * list (by address, email domain, or company domain). This should always be empty.
 */
export async function suppressionLeaks(db: Db, opts: { since?: Date; limit?: number } = {}): Promise<SuppressionLeak[]> {
  const res = await db.execute(sql`
    select distinct on (m.id) m.id as message_id, c.email, m.sent_at, s.created_at as suppressed_at, coalesce(s.email, '@' || s.domain) as entry
    from ${messages} m
    join ${contacts} c on c.id = m.contact_id
    join ${companies} co on co.id = c.company_id
    join ${suppression} s on (
      s.email = lower(c.email)
      or s.domain = split_part(lower(c.email), '@', 2)
      or s.domain = co.domain
    )
    where m.status = 'sent' and m.sent_at > s.created_at ${opts.since ? sql`and m.sent_at >= ${opts.since}` : sql``}
    order by m.id, s.created_at
    limit ${opts.limit ?? 50}`);
  const rows = ((res as { rows?: unknown[] }).rows ?? []) as { message_id: string; email: string; sent_at: string | Date; suppressed_at: string | Date; entry: string }[];
  return rows.map((r) => ({ messageId: r.message_id, to: r.email, sentAt: new Date(r.sent_at), suppressedAt: new Date(r.suppressed_at), entry: r.entry }));
}
