import { teamDay, companies, contacts, type Ctx, DAY, domainOf, isDomainSuppressed, isRoleAddress, isSuppressed, isValidEmailSyntax, normalizeDomain, normalizeEmail, segments } from "@opengtm/core";
import { eq, sql } from "drizzle-orm";
import { SourceOutOfCreditsError, type CompanyCandidate, type LeadSource, type PersonCandidate } from "./types";

/** Mirror business.yaml segments into the segments table (status survives restarts). */
export async function syncSegments(ctx: Ctx): Promise<void> {
  for (const s of ctx.config.business.icp.segments) {
    await ctx.db
      .insert(segments)
      .values({ id: s.id, description: s.description })
      .onConflictDoUpdate({ target: segments.id, set: { description: s.description } });
  }
}

export function matchRole(title: string | undefined, roles: string[]): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  const sorted = [...roles].sort((a, b) => b.length - a.length); // "managing partner" before "partner"
  return sorted.find((r) => t.includes(r.toLowerCase())) ?? (/\b(founder|co-?founder|principal|owner)\b/.test(t) ? "owner" : null);
}

export interface DiscoverStats {
  companiesNew: number;
  companiesExisting: number;
  contactsNew: number;
  skipped: Record<string, number>;
}

async function upsertCompany(ctx: Ctx, c: CompanyCandidate, segmentId: string, source: string): Promise<{ id: string; isNew: boolean }> {
  const domain = normalizeDomain(c.domain);
  const inserted = await ctx.db
    .insert(companies)
    .values({
      domain,
      name: c.name,
      website: c.website ?? `https://${domain}`,
      state: c.state ?? null,
      city: c.city ?? null,
      country: c.country ?? "US",
      companySize: c.companySize ?? null,
      focusAreas: (c.focusAreas ?? []).map((p) => p.toLowerCase()),
      segmentId,
      source,
      sourceRef: c.sourceRef ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: companies.id });
  if (inserted[0]) return { id: inserted[0].id, isNew: true };
  const [existing] = await ctx.db.select({ id: companies.id }).from(companies).where(eq(companies.domain, domain));
  return { id: existing!.id, isNew: false };
}

/**
 * Discover: pull companies then people by role from each source, dedupe by
 * domain and by lowercased email, and log the source of every contact.
 * Suppression is checked before anything is stored or enriched.
 */
export async function runDiscover(
  ctx: Ctx,
  sources: LeadSource[],
  opts: { segmentId?: string; limitPerSegment?: number } = {},
): Promise<DiscoverStats> {
  await syncSegments(ctx);
  const stats: DiscoverStats = { companiesNew: 0, companiesExisting: 0, contactsNew: 0, skipped: {} };
  const skip = (reason: string) => (stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1);
  const { icp } = ctx.config.business;
  const exclude = new Set(icp.exclude_domains.map(normalizeDomain));
  const matching = icp.segments.filter((s) => !opts.segmentId || s.id === opts.segmentId);
  // Start with a different segment each day so a small lead budget reaches every segment in turn.
  const offset = Math.floor(ctx.clock.now().getTime() / 86_400_000) % Math.max(1, matching.length);
  const segs = [...matching.slice(offset), ...matching.slice(0, offset)];
  const pausedRows = await ctx.db.select({ id: segments.id }).from(segments).where(eq(segments.status, "paused"));
  const paused = new Set(pausedRows.map((r) => r.id));

  const outOfCredits = new Set<string>();
  for (const seg of segs) {
    if (paused.has(seg.id)) {
      skip("segment_paused");
      continue;
    }
    for (const source of sources) {
      if (outOfCredits.has(source.name)) continue;
      if (!source.termsAllowOutbound) {
        ctx.log.warn({ source: source.name }, "source not cleared for outbound use; skipping");
        skip("source_terms");
        continue;
      }
      try {
        const found = await source.discoverCompanies({
          segmentId: seg.id,
          keywords: seg.keywords,
          roles: icp.roles,
          limit: opts.limitPerSegment ?? 50,
        });
        for (const c of found) {
          const domain = normalizeDomain(c.domain);
          if (!domain) { skip("no_domain"); continue; }
          if ((c.country ?? "US") !== "US") { skip("non_us"); continue; }
          if (exclude.has(domain)) { skip("excluded_domain"); continue; }
          if (await isDomainSuppressed(ctx.db, domain)) { skip("suppressed_domain"); continue; }

          const { id, isNew } = await upsertCompany(ctx, c, seg.id, source.name);
          if (isNew) stats.companiesNew++;
          else stats.companiesExisting++;

          const people: PersonCandidate[] = await source.findPeople(c, icp.roles);
          for (const p of people) {
            const email = normalizeEmail(p.email);
            if (!isValidEmailSyntax(email)) { skip("bad_syntax"); continue; }
            if (domainOf(email) !== domain && !domainOf(email).endsWith(`.${domain}`)) {
              // Personal/free-mail addresses are not the company's; keep data minimal.
              skip("off_domain_email");
              continue;
            }
            if (await isSuppressed(ctx.db, email, domain)) { skip("suppressed_email"); continue; }
            const inserted = await ctx.db
              .insert(contacts)
              .values({
                companyId: id,
                email,
                firstName: p.firstName ?? null,
                lastName: p.lastName ?? null,
                title: p.title ?? null,
                role: matchRole(p.title, icp.roles),
                isRoleAddress: isRoleAddress(email),
                source: source.name,
                sourceUrl: p.sourceUrl ?? null,
              })
              .onConflictDoNothing()
              .returning({ id: contacts.id });
            if (inserted.length) stats.contactsNew++;
            else skip("duplicate_email");
          }
        }
      } catch (err) {
        if (!(err instanceof SourceOutOfCreditsError)) throw err;
        // Out of credits: stop using this source for the rest of the run and tell the team once a day.
        outOfCredits.add(source.name);
        skip("source_out_of_credits");
        await ctx.alerts.notify({
          level: "critical",
          key: `lead_credits_out:${source.name}:${teamDay(ctx.clock.now())}`,
          quietMs: DAY,
          title: `${source.name === "ai_ark" ? "AI Ark" : source.name} is out of lead credits`,
          body: `${err.message}. No new leads until the plan renews or is upgraded; emails to leads already found keep going.`,
        });
      }
    }
  }
  ctx.log.info({ stats }, "discover done");
  return stats;
}

export async function contactCount(ctx: Ctx): Promise<number> {
  const [r] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(contacts);
  return r?.n ?? 0;
}
