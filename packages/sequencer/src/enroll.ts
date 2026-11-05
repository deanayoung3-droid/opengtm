import {
  campaigns,
  companies,
  contacts,
  domains,
  isSuppressed,
  mailboxes,
  messages,
  segments,
  sequenceSteps,
  threads,
  type Ctx,
} from "@opengtm/core";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { dailyCap } from "./ramp";

type Mailbox = typeof mailboxes.$inferSelect;

/**
 * Choose the mailbox that will own a thread for its whole life:
 * prefer the recipient's provider (Google->Google, Microsoft->Microsoft),
 * then the least-loaded mailbox relative to its cap, then the least-used domain.
 */
export async function pickMailbox(ctx: Ctx, recipientProvider: string | null): Promise<Mailbox | null> {
  const rows = await ctx.db
    .select({ mb: mailboxes })
    .from(mailboxes)
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(and(eq(mailboxes.status, "active"), eq(domains.status, "active")));
  if (rows.length === 0) return null;
  const load = await ctx.db
    .select({ mailboxId: threads.mailboxId, n: sql<number>`count(*)::int` })
    .from(threads)
    .where(inArray(threads.status, ["drafting", "active"]))
    .groupBy(threads.mailboxId);
  const loadBy = new Map(load.map((l) => [l.mailboxId, l.n]));
  const domainLoad = new Map<string, number>();
  for (const { mb } of rows) domainLoad.set(mb.domainId, (domainLoad.get(mb.domainId) ?? 0) + (loadBy.get(mb.id) ?? 0));

  const now = ctx.clock.now();
  const all = rows.map((r) => r.mb);
  const matching = recipientProvider === "google" || recipientProvider === "microsoft" ? all.filter((m) => m.provider === recipientProvider) : [];
  const pool = matching.length ? matching : all;
  const scored = pool
    .map((mb) => ({ mb, ratio: (loadBy.get(mb.id) ?? 0) / Math.max(1, dailyCap(mb, now, ctx.config.engine.ramp)), dom: domainLoad.get(mb.domainId) ?? 0, tie: ctx.random() }))
    .sort((a, b) => a.ratio - b.ratio || a.dom - b.dom || a.tie - b.tie);
  return scored[0]?.mb ?? null;
}

/**
 * How many new people the mailboxes can start on a day (each gets every step of the sequence), and how many
 * companies already have someone waiting for a first email. Discovery buys only the difference, so paid leads
 * never pile up while mailboxes are paused or still ramping.
 */
export async function leadStock(ctx: Ctx): Promise<{ perDay: number; waiting: number }> {
  const now = ctx.clock.now();
  const e = ctx.config.engine;
  const activeMbs = await ctx.db.select().from(mailboxes).where(eq(mailboxes.status, "active"));
  const capacity = Math.min(e.caps.daily_send_cap, activeMbs.reduce((s, m) => s + dailyCap(m, now, e.ramp), 0));
  const perDay = Math.floor(capacity / Math.max(1, e.sequence.steps.length));
  // Companies (one contact each) found or verified but not emailed yet, plus first emails already queued.
  const [ready] = await ctx.db
    .select({ n: sql<number>`count(distinct ${contacts.companyId})::int` })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(
      and(
        inArray(contacts.status, ["new", "verified"]),
        sql`${companies.status} not in ('disqualified', 'research_failed')`,
        sql`not exists (select 1 from threads t where t.company_id = ${contacts.companyId})`,
      ),
    );
  const [queued] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(eq(messages.stepNumber, 1), inArray(messages.status, ["draft", "scheduled"]), inArray(threads.status, ["drafting", "active"])));
  return { perDay, waiting: (ready?.n ?? 0) + (queued?.n ?? 0) };
}

function roleRank(role: string | null, roles: string[]): number {
  const i = role ? roles.indexOf(role) : -1;
  return i === -1 ? roles.length : i;
}

/**
 * Enroll verified contacts of researched companies into their segment's campaign.
 * One contact per company (best role first), never someone already in a sequence,
 * and never more backlog than about two days of sending capacity.
 */
export async function runEnroll(ctx: Ctx, limit = 50): Promise<{ enrolled: number }> {
  const now = ctx.clock.now();
  const activeMbs = await ctx.db.select().from(mailboxes).where(eq(mailboxes.status, "active"));
  const capacity = activeMbs.reduce((s, m) => s + dailyCap(m, now, ctx.config.engine.ramp), 0);
  const [backlogRow] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(eq(messages.stepNumber, 1), inArray(messages.status, ["draft", "scheduled"]), inArray(threads.status, ["drafting", "active"])));
  const [draftingRow] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(threads)
    .where(and(eq(threads.status, "drafting"), sql`not exists (select 1 from messages m where m.thread_id = ${threads.id})`));
  const backlog = (backlogRow?.n ?? 0) + (draftingRow?.n ?? 0);
  let room = Math.min(limit, Math.max(0, capacity * 2 - backlog));
  if (room === 0) return { enrolled: 0 };

  const active = await ctx.db
    .select({ c: campaigns })
    .from(campaigns)
    .innerJoin(segments, eq(segments.id, campaigns.segmentId))
    .where(and(eq(campaigns.status, "active"), eq(segments.status, "active")));

  let enrolled = 0;
  for (const { c: campaign } of active) {
    if (room <= 0) break;
    const candidates = await ctx.db
      .select({ contact: contacts, companyDomain: companies.domain })
      .from(contacts)
      .innerJoin(companies, eq(companies.id, contacts.companyId))
      .where(
        and(
          eq(contacts.status, "verified"),
          eq(companies.status, "researched"),
          eq(companies.segmentId, campaign.segmentId),
          or(isNull(contacts.retouchAt), lte(contacts.retouchAt, now)),
          sql`not exists (select 1 from threads t where t.contact_id = ${contacts.id})`,
          ctx.config.engine.sequence.one_contact_per_company
            ? // Referrals were asked for by the company, so they bypass one-contact-per-company.
              sql`(${contacts.source} = 'referral' or not exists (select 1 from threads t where t.company_id = ${contacts.companyId} and t.campaign_id = ${campaign.id}))`
            : sql`true`,
        ),
      )
      // The person who decides first (in the ICP's role order) at a named address, then the
      // best-fitting companies, newest first.
      .orderBy(
        asc(contacts.isRoleAddress),
        sql`case ${contacts.role} ${sql.join(
          ctx.config.business.icp.roles.map((r, i) => sql`when ${r} then ${sql.raw(String(i))}`),
          sql` `,
        )} else ${sql.raw(String(ctx.config.business.icp.roles.length))} end`,
        sql`${companies.icpScore} desc nulls last`,
        desc(companies.createdAt),
      )
      .limit(room * 4);

    const best = new Map<string, typeof contacts.$inferSelect>();
    const roles = ctx.config.business.icp.roles;
    const companyDomain = new Map(candidates.map((r) => [r.contact.id, r.companyDomain]));
    for (const { contact } of candidates) {
      const cur = best.get(contact.companyId);
      if (!ctx.config.engine.sequence.one_contact_per_company || contact.source === "referral") best.set(contact.id, contact);
      else if (!cur || roleRank(contact.role, roles) < roleRank(cur.role, roles)) best.set(contact.companyId, contact);
    }

    const variants = await ctx.db
      .selectDistinct({ v: sequenceSteps.variant })
      .from(sequenceSteps)
      .where(and(eq(sequenceSteps.sequenceId, campaign.sequenceId), eq(sequenceSteps.stepNumber, 1), eq(sequenceSteps.status, "active")));
    const variantList = variants.map((v) => v.v).sort();
    if (variantList.length === 0) continue;

    for (const contact of best.values()) {
      if (room <= 0) break;
      if (await isSuppressed(ctx.db, contact.email, companyDomain.get(contact.id))) continue;
      const mb = await pickMailbox(ctx, contact.mailProvider);
      if (!mb) {
        ctx.log.warn("no active mailbox available; enrollment paused");
        return { enrolled };
      }
      const variant = variantList[Math.floor(ctx.random() * variantList.length)]!;
      const inserted = await ctx.db
        .insert(threads)
        .values({ contactId: contact.id, companyId: contact.companyId, campaignId: campaign.id, mailboxId: mb.id, variant, status: "drafting" })
        .onConflictDoNothing()
        .returning({ id: threads.id });
      if (!inserted.length) continue;
      await ctx.db.update(contacts).set({ status: "enrolled", updatedAt: now }).where(eq(contacts.id, contact.id));
      enrolled++;
      room--;
    }
  }
  return { enrolled };
}
