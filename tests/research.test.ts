import { companies, contacts, facts } from "@opengtm/core";
import { createTestCtx, FakeLlm, type TestCtx } from "@opengtm/core/testing";
import { detectSignals, groundFacts, htmlToText, pickResearchPages, extractLinks, researchCompany, runResearch, StaticFetcher, PoliteFetcher } from "@opengtm/research";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SITE = "https://rivera-family.biz.example";
const pages: Record<string, string> = {
  [SITE]: `<html><head><title>Rivera Heating & Air</title></head><body>
    <nav><a href="/about">About</a><a href="/careers">Careers</a><a href="/services">Services</a><a href="/blog/post-1">Blog</a></nav>
    <h1>Rivera Heating & Air</h1><p>Helping Austin families through furnace repair and ac installation since 2009.</p></body></html>`,
  [`${SITE}/about`]: `<html><body><h1>About us</h1><p>Rivera Heating & Air was founded in 2009 by Ana Rivera.</p>
    <p>Our four technicians focus exclusively on hvac in Travis County.</p><p>We moved our scheduling to Jobber last year.</p></body></html>`,
  [`${SITE}/careers`]: `<html><body><h1>Careers</h1><p>We are hiring a full-time HVAC technician to join our team in Austin.</p></body></html>`,
  [`${SITE}/services`]: `<html><body><ul><li>Furnace repair</li><li>AC installation</li><li>Water heaters</li></ul></body></html>`,
};

describe("research + facts store", () => {
  let ctx: TestCtx;
  let llm: FakeLlm;
  beforeEach(async () => {
    llm = new FakeLlm();
    ctx = await createTestCtx({ llm });
  });
  afterEach(async () => ctx.close());

  async function seedCompany() {
    const [c] = await ctx.db
      .insert(companies)
      .values({ domain: "rivera-family.biz.example", name: "Rivera Heating & Air", website: SITE, state: "TX", source: "test", status: "qualified" })
      .returning();
    await ctx.db.insert(contacts).values({ companyId: c!.id, email: "ana@rivera-family.biz.example", source: "test", status: "verified" });
    return c!;
  }

  it("stores grounded facts with source URLs and detects signals", async () => {
    llm.on("research_extract", (input) => {
      expect(input.prompt).toContain(`<page url="${SITE}/about">`);
      return {
        facts: [
          { text: "Rivera Heating & Air was founded in 2009 by Ana Rivera", source_url: `${SITE}/about`, kind: "about" },
          { text: "Four technicians focus exclusively on hvac in Travis County", source_url: `${SITE}/about/`, kind: "about" },
          { text: "The company won the 2024 Austin Business Journal award", source_url: `${SITE}/about`, kind: "news" }, // hallucinated
          { text: "Practices furnace repair, child ac installation and adoption", source_url: `${SITE}/nonexistent`, kind: "services" }, // unknown URL
        ],
        focus_areas: ["hvac", "furnace repair"],
        team_size: 4,
      };
    });
    const company = await seedCompany();
    const [out] = await runResearch(ctx, new StaticFetcher(pages));
    expect(out!.status).toBe("researched");

    const stored = await ctx.db.select().from(facts).where(eq(facts.companyId, company.id));
    const texts = stored.map((f) => f.text);
    expect(texts).toContain("Rivera Heating & Air was founded in 2009 by Ana Rivera");
    expect(texts).toContain("Four technicians focus exclusively on hvac in Travis County");
    expect(texts.some((t) => t.includes("award"))).toBe(false);
    expect(texts.some((t) => t.startsWith("Practices furnace repair"))).toBe(false);
    expect(stored.every((f) => Object.keys(pages).includes(f.sourceUrl))).toBe(true);
    expect(stored.filter((f) => f.kind === "signal").length).toBe(2);

    const [after] = await ctx.db.select().from(companies).where(eq(companies.id, company.id));
    expect(after!.signals.sort()).toEqual(["hiring", "mentions_competitor"]);
    expect(after!.companySize).toBe(4);
    expect(llm.calls[0]!.opts.companyId).toBe(company.id); // spend is attributed per lead
  });

  it("keeps a model's answer that lists more facts or focus areas than asked, using the first ones", async () => {
    llm.on("research_extract", () => ({
      facts: Array.from({ length: 15 }, () => ({ text: "Rivera Heating & Air was founded in 2009 by Ana Rivera", source_url: `${SITE}/about`, kind: "about" })),
      focus_areas: Array.from({ length: 14 }, (_, i) => `area ${i}`),
      team_size: 4,
    }));
    const company = await seedCompany();
    const [out] = await runResearch(ctx, new StaticFetcher(pages));
    expect(out!.status).toBe("researched");
    const stored = await ctx.db.select().from(facts).where(eq(facts.companyId, company.id));
    expect(stored.some((f) => f.text === "Rivera Heating & Air was founded in 2009 by Ana Rivera")).toBe(true);
    const [after] = await ctx.db.select().from(companies).where(eq(companies.id, company.id));
    expect(after!.focusAreas.length).toBeLessThanOrEqual(10);
  });

  it("is idempotent and degrades to rule-based facts when no model is available", async () => {
    llm.on("research_extract", () => {
      throw new (class extends Error {})("boom");
    });
    const company = await seedCompany();
    await expect(researchCompany(ctx, company.id, new StaticFetcher(pages))).rejects.toThrow("boom");

    const { LlmExhaustedError } = await import("@opengtm/core");
    llm.on("research_extract", () => {
      throw new LlmExhaustedError("research_extract", ["local down"]);
    });
    await researchCompany(ctx, company.id, new StaticFetcher(pages));
    await researchCompany(ctx, company.id, new StaticFetcher(pages));
    const stored = await ctx.db.select().from(facts).where(eq(facts.companyId, company.id));
    expect(stored).toHaveLength(2); // only the two signal facts, not duplicated
  });

  it("marks research failed when the homepage is unavailable", async () => {
    const company = await seedCompany();
    const out = await researchCompany(ctx, company.id, new StaticFetcher({}));
    expect(out.status).toBe("research_failed");
  });

  it("grounding rejects facts whose words are not on the cited page", () => {
    const page = { url: `${SITE}/about`, status: 200, html: "", fetchedAt: new Date(), ...htmlToText(pages[`${SITE}/about`]!) };
    const kept = groundFacts(
      [
        { text: "Founded in 2009 by Ana Rivera", source_url: `${SITE}/about`, kind: "about" },
        { text: "Serves clients in Dallas and Houston courts", source_url: `${SITE}/about`, kind: "about" },
      ],
      [page],
    );
    expect(kept.map((k) => k.text)).toEqual(["Founded in 2009 by Ana Rivera"]);
  });

  it("picks informative pages and detects launch signals", () => {
    const picked = pickResearchPages(extractLinks(pages[SITE]!, SITE), 5);
    expect(picked).toContain(`${SITE}/about`);
    expect(picked).toContain(`${SITE}/careers`);
    const sig = detectSignals(
      [{ url: `${SITE}/news`, status: 200, html: "", title: "", fetchedAt: new Date(), text: "We are proud to announce the opening of our second office in Round Rock." }],
      new Date("2026-10-20"),
    );
    expect(sig.map((s) => s.signal)).toEqual(["new_office_or_launch"]);
  });

  it("PoliteFetcher honors robots.txt and returns only HTML", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /private", { status: 200 });
      if (u.endsWith(".pdf")) return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
      return new Response("<p>Hello there</p>", { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const f = new PoliteFetcher({ userAgent: "test", delayMs: 0, fetchImpl });
    expect(await f.fetch(`${SITE}/private/x`)).toBeNull();
    expect(await f.fetch(`${SITE}/file.pdf`)).toBeNull();
    expect((await f.fetch(`${SITE}/ok`))?.text).toBe("Hello there");
    expect(calls.filter((c) => c.endsWith("robots.txt"))).toHaveLength(1);
    expect(calls).not.toContain(`${SITE}/private/x`);
  });
});
