import { billingCycleStart, companies, contacts, recordSpend } from "@opengtm/core";
import { createTestCtx, type TestCtx } from "@opengtm/core/testing";
import { AiArkSource, MemoryCursorStore, nameKeys, runDiscover, SourceOutOfCreditsError, type LeadSource } from "@opengtm/leads";
import { MockVerifier, StaticMxResolver, runVerify, VerifierUnavailableError } from "@opengtm/verify";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedMailbox } from "./fixtures";
import { leadSources } from "../apps/worker/src/jobs";
import type { Runtime } from "../apps/worker/src/context";

describe("lead budget", () => {
  let ctx: TestCtx;
  afterEach(async () => {
    vi.unstubAllGlobals();
    await ctx?.close();
    ctx = undefined as unknown as TestCtx;
  });

  const runtime = (c: TestCtx) => ({ ctx: c, dryRun: false, fetcher: {} }) as unknown as Runtime;
  const runBudget = (s: AiArkSource) => (s as unknown as { opts: { maxCreditsPerRun: number } }).opts.maxCreditsPerRun;
  // Five fully ramped mailboxes, so sending room (lead pacing) never limits these budget checks.
  const mailboxes = async (c: TestCtx) => {
    for (let i = 0; i < 5; i++) await seedMailbox(c, { email: `m${i}@outreach-mail.example`, rampStart: new Date(c.clock.now().getTime() - 60 * 86_400_000) });
  };

  it("AI Ark gets only what is left of the monthly credit budget", async () => {
    ctx = await createTestCtx();
    ctx.env = { AI_ARK_API_KEY: "k", AI_ARK_TERMS_OK: "1" };
    const credit = ctx.config.engine.leads.ai_ark.credit_usd;
    // A free-plan budget (100 a month, 50 a run) keeps the numbers small.
    Object.assign(ctx.config.engine.leads.ai_ark, { max_credits_per_month: 100, max_credits_per_run: 50, renews_on_day: 1 });
    await mailboxes(ctx);

    // Last month's spend doesn't count; this month's does.
    await recordSpend(ctx.db, "lead_data", 80 * credit, { ref: "ai_ark", at: new Date("2026-09-28T12:00:00Z") });
    let [src] = (await leadSources(runtime(ctx))) as AiArkSource[];
    expect(runBudget(src!)).toBe(50); // per-run ceiling

    await recordSpend(ctx.db, "lead_data", 99 * credit, { ref: "ai_ark", at: new Date("2026-10-02T12:00:00Z") });
    [src] = (await leadSources(runtime(ctx))) as AiArkSource[];
    expect(runBudget(src!)).toBe(1);

    // 1 credit can't buy a preview page and a lookup, so nothing is called.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await runDiscover(ctx, [src!], { segmentId: "hvac" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts credits from the plan's renewal day, not the 1st", async () => {
    ctx = await createTestCtx({ start: "2026-10-26T15:00:00Z" });
    ctx.env = { AI_ARK_API_KEY: "k", AI_ARK_TERMS_OK: "1" };
    Object.assign(ctx.config.engine.leads.ai_ark, { max_credits_per_month: 100, max_credits_per_run: 50, renews_on_day: 23 });
    await mailboxes(ctx);
    const credit = ctx.config.engine.leads.ai_ark.credit_usd;
    await recordSpend(ctx.db, "lead_data", 40 * credit, { ref: "ai_ark", at: new Date("2026-10-10T12:00:00Z") }); // previous cycle
    await recordSpend(ctx.db, "lead_data", 70 * credit, { ref: "ai_ark", at: new Date("2026-10-24T12:00:00Z") }); // this cycle
    const [src] = (await leadSources(runtime(ctx))) as AiArkSource[];
    expect(runBudget(src!)).toBe(30);
    expect(billingCycleStart(new Date("2026-10-22T12:00:00Z"), 23).toISOString()).toBe("2026-09-23T00:00:00.000Z");
  });

  it("stops and alerts once when the lead vendor is out of credits", async () => {
    ctx = await createTestCtx();
    let calls = 0;
    const dry: LeadSource = {
      name: "ai_ark",
      termsAllowOutbound: true,
      discoverCompanies: async () => {
        calls++;
        throw new SourceOutOfCreditsError("AI Ark is out of credits (402: no credits left)");
      },
      findPeople: async () => [],
    };
    const stats = await runDiscover(ctx, [dry]);
    expect(calls).toBe(1); // not retried for every campaign
    expect(stats.skipped.source_out_of_credits).toBe(1);
    expect(ctx.sink.alerts.map((a) => a.title)).toEqual(["AI Ark is out of lead credits"]);
  });

  it("starts with a different segment each day", async () => {
    ctx = await createTestCtx();
    const order: string[] = [];
    const recorder: LeadSource = {
      name: "rec",
      termsAllowOutbound: true,
      discoverCompanies: async (q) => (order.push(q.segmentId), []),
      findPeople: async () => [],
    };
    await runDiscover(ctx, [recorder]);
    const day1 = [...order];
    order.length = 0;
    (ctx.clock as unknown as { set(d: string): void }).set("2026-10-21T15:00:00Z");
    await runDiscover(ctx, [recorder]);
    expect(day1).toHaveLength(ctx.config.business.icp.segments.length);
    expect(order[0]).toBe(day1[1]);
    expect([...order].sort()).toEqual([...day1].sort());
  });

  it("preview mode pays a flat page price and one lookup per new company, skipping known companies for free", async () => {
    ctx = await createTestCtx();
    const calls: { path: string; body: any }[] = [];
    const person = (id: string, company: string, name: string, title: string) => ({ id, profile: { first_name: "A", last_name: "B*****", title }, company: { id: company, summary: { name } }, location: { country: "United States", state: "Texas" } });
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init!.body));
      calls.push({ path, body });
      if (path.endsWith("/people/preview")) {
        const content = [person("a1", "F1", "Oak Cleaning", "Associate"), person("a2", "F1", "Oak Cleaning", "Owner"), person("b1", "F2", "Elm Cleaning", "Partner"), person("b2", "F2", "Elm Cleaning", "Dispatcher"), person("c1", "F3", "Brightline Group, LLC", "Owner")];
        return new Response(JSON.stringify({ content, totalPages: 9 }), { status: 200 });
      }
      // Email lookups: the owner at Oak Cleaning has one; Elm's partner has none (free), its dispatcher does.
      const emails: Record<string, string> = { a2: "ana@oaklaw.example", b2: "bo@elmlegal.example" };
      if (!emails[body.id]) return new Response("not found", { status: 404 });
      const domain = emails[body.id]!.split("@")[1];
      return new Response(JSON.stringify({ profile: { first_name: "Ana", last_name: "Lopez", title: "Owner" }, company: { link: { domain, website: `https://${domain}` } }, email: { output: [{ address: emails[body.id], status: "VALID", found: true }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const spent: number[] = [];
    const cursor = new MemoryCursorStore();
    await cursor.set("ai_ark:page:landscaping", 25); // where the old 10-per-page search had reached
    const src = new AiArkSource({ apiKey: "k", termsAllowOutbound: true, maxCreditsPerRun: 20, maxExportsPerCompany: 2, employeeMin: 1, employeeMax: 20, industries: [], pageSize: 10, cursor, fetchImpl, sleep: async () => {}, preview: true, knownCompany: async (f) => nameKeys(f.name).includes("brightlinegroup"), onSpend: (c) => void spent.push(c) });
    const companies = await src.discoverCompanies({ segmentId: "landscaping", keywords: ["landscaping"], roles: ["owner", "partner"], limit: 10 });

    expect(calls[0]).toMatchObject({ path: "/api/developer-portal/v1/people/preview", body: { page: 2, size: 100 } }); // page 25 x 10 -> page 2 x 100
    expect(calls.filter((c) => c.path.endsWith("/export/single")).map((c) => c.body.id)).toEqual(["a2", "b1", "b2"]); // owner first, Brightline never looked up
    expect(spent).toEqual([1, 1, 1]); // one preview page + two found emails; the miss was free
    expect(src).toMatchObject({ creditsUsed: 3, skippedKnown: 1, notFound: 1 });
    expect(companies.map((f) => [f.domain, f.people![0]!.email, f.sourceRef])).toEqual([
      ["oaklaw.example", "ana@oaklaw.example", "ai_ark:F1"],
      ["elmlegal.example", "bo@elmlegal.example", "ai_ark:F2"],
    ]);
    expect(await src.findPeople(companies[0]!, ["owner"])).toHaveLength(1); // already looked up: no second charge
    expect(spent).toHaveLength(3);
    expect(await cursor.get("ai_ark:preview:landscaping")).toBe(3);
  });

  it("recognizes companies by name against known websites", () => {
    expect(nameKeys("Bright Path Group, LLC")).toContain("brightpathgroup");
    expect(nameKeys("Bright Path Group, LLC")).toContain("brightpath");
    expect(nameKeys("The Smith Company, Inc.")).toContain("smith");
    expect(nameKeys("Ridder, Costa & Johnstone LLP")).toContain("riddercostajohnstone");
    expect(nameKeys("Hollis Services")).toContain("hollis");
    expect(nameKeys("Hollis Services")).not.toContain("sler");
  });

  it("AI Ark keeps a fixed page size across runs and keeps every company it paid for", async () => {
    ctx = await createTestCtx();
    const sizes: number[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      sizes.push(body.size);
      const content = Array.from({ length: body.size }, (_, i) => ({ id: `p${body.page}-${i}`, profile: { title: "Owner" }, company: { link: { domain: `company${body.page}-${i}.example` } } }));
      return new Response(JSON.stringify({ content, totalPages: 50 }), { status: 200 });
    }) as unknown as typeof fetch;
    const cursor = new MemoryCursorStore();
    const src = () => new AiArkSource({ apiKey: "k", termsAllowOutbound: true, maxCreditsPerRun: 100, maxExportsPerCompany: 1, employeeMin: 1, employeeMax: 20, industries: [], pageSize: 10, cursor, fetchImpl, sleep: async () => {} });
    const q = { segmentId: "hvac", keywords: ["hvac"], roles: ["owner"], limit: 3 };
    expect(await src().discoverCompanies(q)).toHaveLength(10); // all 10 paid-for companies, not just 3
    await src().discoverCompanies({ ...q, limit: 25 });
    expect(sizes).toEqual([10, 10, 10, 10]); // same size every page and run, so page numbers stay valid
    expect(await cursor.get("ai_ark:page:hvac")).toBe(4);
  });

  it("AI Ark waits and retries when rate-limited, and skips a company instead of failing the run", async () => {
    const waits: number[] = [];
    let exportCalls = 0;
    const fetchImpl = (async (url: unknown) => {
      if (String(url).endsWith("/v1/people")) {
        return new Response(JSON.stringify({ content: [{ id: "a", profile: { title: "Owner" }, company: { link: { domain: "a.example" } } }, { id: "b", profile: { title: "Owner" }, company: { link: { domain: "b.example" } } }], totalPages: 1 }), { status: 200 });
      }
      exportCalls++;
      if (exportCalls <= 2) return new Response("slow down", { status: 429, headers: { "retry-after": "3" } });
      if (exportCalls <= 9) return new Response("slow down", { status: 429 }); // company b: never recovers
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const src = new AiArkSource({ apiKey: "k", termsAllowOutbound: true, maxCreditsPerRun: 100, maxExportsPerCompany: 1, employeeMin: 1, employeeMax: 20, industries: [], fetchImpl, sleep: async (ms) => void waits.push(ms) });
    const companies = await src.discoverCompanies({ segmentId: "s", keywords: ["x"], roles: ["owner"], limit: 2 });
    const a = await src.findPeople(companies[0]!, ["owner"]);
    expect(waits).toContain(3000); // honoured Retry-After
    expect(a).toEqual([]); // 200 with no email in the body: nothing found, nothing charged
    exportCalls = 3; // next company hits 429 on every attempt
    expect(await src.findPeople(companies[1]!, ["owner"])).toEqual([]);
    expect(src.failures).toHaveLength(1);
    expect(src.creditsUsed).toBe(1); // only the 2-person search page
  });

  it("AI Ark emails skip the paid check; other sources wait for ZeroBounce", async () => {
    ctx = await createTestCtx();
    expect(ctx.config.engine.verify.trust_sources).toEqual(["ai_ark"]);
    const [co] = await ctx.db.insert(companies).values({ name: "Oak Cleaning", domain: "oak.example", source: "ai_ark", status: "qualified", country: "US" }).returning();
    await ctx.db.insert(contacts).values([
      { companyId: co!.id, email: "ana@oak.example", source: "ai_ark" },
      { companyId: co!.id, email: "bo@oak.example", source: "csv" },
    ]);
    const stats = await runVerify(ctx, { verifier: null, mx: new StaticMxResolver({}, ["aspmx.l.google.com"]) });
    expect(stats).toMatchObject({ verified: 1, deferred: 1 });
    const [ana] = await ctx.db.select().from(contacts).where(eq(contacts.email, "ana@oak.example"));
    const [bo] = await ctx.db.select().from(contacts).where(eq(contacts.email, "bo@oak.example"));
    expect(ana).toMatchObject({ status: "verified", verifyStatus: "valid", mailProvider: "google" });
    expect(bo!.status).toBe("new");
  });

  it("with ZeroBounce set up, AI Ark emails get a second opinion: bounces dropped, catch-alls kept", async () => {
    ctx = await createTestCtx();
    const [co] = await ctx.db.insert(companies).values({ name: "Elm Cleaning", domain: "elm.example", source: "ai_ark", status: "qualified", country: "US" }).returning();
    await ctx.db.insert(contacts).values([
      { companyId: co!.id, email: "ana@elm.example", source: "ai_ark" },
      { companyId: co!.id, email: "invalid.bo@elm.example", source: "ai_ark" },
      { companyId: co!.id, email: "catchall.cy@elm.example", source: "ai_ark" },
      { companyId: co!.id, email: "catchall.di@elm.example", source: "csv" },
    ]);
    const verifier = new MockVerifier(0);
    await runVerify(ctx, { verifier, mx: new StaticMxResolver({}, ["aspmx.l.google.com"]) });
    const status = async (email: string) => (await ctx!.db.select().from(contacts).where(eq(contacts.email, email)))[0]!.status;
    expect(verifier.checked).toHaveLength(4);
    expect(await status("ana@elm.example")).toBe("verified");
    expect(await status("invalid.bo@elm.example")).toBe("dropped"); // would bounce: never emailed
    expect(await status("catchall.cy@elm.example")).toBe("verified"); // AI Ark already vouched for it
    expect(await status("catchall.di@elm.example")).toBe("dropped"); // other sources need "valid"
  });

  it("when ZeroBounce is out of credits, AI Ark emails pass on AI Ark's word and others wait", async () => {
    ctx = await createTestCtx();
    const [co] = await ctx.db.insert(companies).values({ name: "Ash Cleaning", domain: "ash.example", source: "ai_ark", status: "qualified", country: "US" }).returning();
    await ctx.db.insert(contacts).values([
      { companyId: co!.id, email: "ana@ash.example", source: "ai_ark" },
      { companyId: co!.id, email: "bo@ash.example", source: "csv" },
    ]);
    const broke = { name: "zerobounce", verify: async () => Promise.reject(new VerifierUnavailableError("zerobounce: your account ran out of credits")) };
    const stats = await runVerify(ctx, { verifier: broke, mx: new StaticMxResolver({}, ["aspmx.l.google.com"]) });
    expect(stats).toMatchObject({ verified: 1, deferred: 1 });
  });
});
