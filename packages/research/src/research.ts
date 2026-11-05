import {
  companies,
  contacts,
  facts,
  isDomainSuppressed,
  LlmExhaustedError,
  NoRouteError,
  SpendCapError,
  type Ctx,
} from "@opengtm/core";
import { and, eq, exists, inArray } from "drizzle-orm";
import { extractFacts, type ExtractedFact } from "./extract";
import { extractLinks, pickResearchPages, type FetchedPage, type PageFetcher } from "./fetcher";
import { detectSignals } from "./signals";

export interface ResearchOutcome {
  companyId: string;
  status: "researched" | "research_failed" | "skipped";
  facts: number;
  signals: string[];
  reason?: string;
}

/**
 * Fetch the company's site, extract atomic facts with source URLs, detect signals.
 * Idempotent: re-running replaces the company's facts.
 */
export async function researchCompany(ctx: Ctx, companyId: string, fetcher: PageFetcher): Promise<ResearchOutcome> {
  const [company] = await ctx.db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) return { companyId, status: "skipped", facts: 0, signals: [], reason: "not found" };
  if (await isDomainSuppressed(ctx.db, company.domain)) {
    return { companyId, status: "skipped", facts: 0, signals: [], reason: "domain suppressed" };
  }
  await ctx.db.update(companies).set({ status: "researching", updatedAt: ctx.clock.now() }).where(eq(companies.id, companyId));

  const home = await fetcher.fetch(company.website ?? `https://${company.domain}`);
  if (!home) {
    await ctx.db.update(companies).set({ status: "research_failed", updatedAt: ctx.clock.now() }).where(eq(companies.id, companyId));
    return { companyId, status: "research_failed", facts: 0, signals: [], reason: "homepage unavailable or disallowed" };
  }
  const pages: FetchedPage[] = [home];
  for (const url of pickResearchPages(extractLinks(home.html, home.url), ctx.config.engine.research.max_pages - 1)) {
    const p = await fetcher.fetch(url);
    if (p && p.text.length > 50) pages.push(p);
  }

  const signals = detectSignals(pages, ctx.clock.now(), {
    competitors: ctx.config.business.competitors,
    ownName: ctx.config.business.company.name,
    enabled: ctx.config.business.signals,
  });
  const found: ExtractedFact[] = signals.map((s) => ({ text: s.evidence, sourceUrl: s.url, kind: "careers" as const }));
  let focusAreas: string[] = [];
  let teamSize: number | null = null;
  let llmNote: string | undefined;
  try {
    const ex = await extractFacts(ctx, companyId, company.name, pages);
    const known = new Set(found.map((f) => f.text.toLowerCase()));
    for (const f of ex.facts) if (!known.has(f.text.toLowerCase())) found.push(f);
    focusAreas = ex.focusAreas;
    teamSize = ex.teamSize;
  } catch (err) {
    if (!(err instanceof SpendCapError || err instanceof LlmExhaustedError || err instanceof NoRouteError)) throw err;
    llmNote = err.message;
    ctx.log.warn({ companyId, err: err.message }, "fact extraction unavailable; keeping rule-based facts only");
  }

  const fetchedAt = ctx.clock.now();
  await ctx.db.transaction(async (tx) => {
    await tx.delete(facts).where(eq(facts.companyId, companyId));
    if (found.length) {
      await tx.insert(facts).values(
        found.map((f) => ({
          companyId,
          text: f.text,
          sourceUrl: f.sourceUrl,
          fetchedAt,
          kind: signals.some((s) => s.evidence === f.text) ? ("signal" as const) : f.kind,
        })),
      );
    }
    await tx
      .update(companies)
      .set({
        status: "researched",
        researchedAt: fetchedAt,
        signals: [...new Set(signals.map((s) => s.signal))],
        focusAreas: company.focusAreas.length ? company.focusAreas : focusAreas,
        companySize: company.companySize ?? teamSize,
        updatedAt: fetchedAt,
      })
      .where(eq(companies.id, companyId));
  });
  return { companyId, status: "researched", facts: found.length, signals: [...new Set(signals.map((s) => s.signal))], reason: llmNote };
}

/** Research qualified companies that have at least one verified contact. */
export async function runResearch(ctx: Ctx, fetcher: PageFetcher, limit = 10): Promise<ResearchOutcome[]> {
  const rows = await ctx.db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.status, "qualified"),
        exists(
          ctx.db
            .select({ one: contacts.id })
            .from(contacts)
            .where(and(eq(contacts.companyId, companies.id), inArray(contacts.status, ["verified"]))),
        ),
      ),
    )
    .limit(limit);
  const one = async (r: { id: string }): Promise<ResearchOutcome> => {
    try {
      return await researchCompany(ctx, r.id, fetcher);
    } catch (err) {
      ctx.log.error({ err, companyId: r.id }, "research failed");
      await ctx.db.update(companies).set({ status: "research_failed" }).where(eq(companies.id, r.id));
      return { companyId: r.id, status: "research_failed", facts: 0, signals: [], reason: (err as Error).message };
    }
  };
  // A few companies at a time (different websites, so still polite to each): at ~1,000 emails a day one at a time
  // can't keep up, and a run must finish well inside the job's time limit.
  const out: ResearchOutcome[] = [];
  for (let i = 0; i < rows.length; i += PARALLEL) out.push(...(await Promise.all(rows.slice(i, i + PARALLEL).map(one))));
  return out;
}

const PARALLEL = 5;
