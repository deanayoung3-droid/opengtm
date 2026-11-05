import {
  companies,
  contacts,
  createLlm,
  JevProvider,
  LlmExhaustedError,
  llmCalls,
  loadConfig,
  ManualClock,
  providersFromEnv,
  silentLogger,
  type DecisionQuestion,
} from "@opengtm/core";
import { createTestCtx, createTestDb, FakeLlm, testConfig, type TestCtx } from "@opengtm/core/testing";
import { AiArkSource, MemoryCursorStore, runDiscover, runQualify } from "@opengtm/leads";
import { classifyReply } from "@opengtm/replies";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const Q: Record<string, DecisionQuestion> = {
  label: { type: "choice", instructions: "What does the sender want?", criteria: { interested: "Wants a meeting", unsubscribe: "Wants no more email" } },
  whole_firm: { type: "noul", instructions: "Asks that nobody at the company be contacted" },
};

describe("routing: OpenAI only, no Claude", () => {
  it("never builds an Anthropic provider, even if a key is present", () => {
    const cfg = loadConfig({ env: {} });
    const providers = providersFromEnv(cfg.llm, { ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-x" });
    expect(Object.keys(providers)).toEqual(["openai"]);
  });
});

// Jev is not in config/llm.yaml any more; the adapter stays available if a decision route is added back.
describe("Jev decision provider through the router (optional)", () => {
  let close: () => Promise<void>;
  afterEach(async () => close?.());

  async function router(fetchImpl: typeof fetch) {
    const t = await createTestDb();
    close = t.close;
    const config = testConfig((c) => {
      c.llm.providers.jev = { api_key_env: "TYPESAFE_API_KEY" };
      c.llm.pricing["jev-latest"] = { in: 0.042, out: 0 };
      c.llm.decisions = { reply_classify: [{ provider: "jev", model: "jev-latest" }] };
    });
    const llm = createLlm({ db: t.db, config, providers: {}, decisionProviders: { jev: new JevProvider({ apiKey: "ts-key", fetch: fetchImpl }) }, clock: new ManualClock("2026-10-20T15:00:00Z"), log: silentLogger, sleep: async () => {} });
    return { llm, db: t.db };
  }

  it("sends the documented request, validates answers, and logs cost", async () => {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer ts-key");
      const body = JSON.parse(String(init!.body));
      expect(body).toMatchObject({ model: "jev-latest", state: "Please remove me" });
      expect(body.questions.label.criteria.unsubscribe).toBe("Wants no more email");
      return json({
        model: "jev-1.13.0",
        answers: {
          label: { type: "choice", choice: "unsubscribe", confidence: 0.97, probabilities: { interested: 0.03, unsubscribe: 0.97 } },
          whole_firm: { type: "noul", noul: 0.1 },
        },
        usage: { input_tokens: 1000, output_tokens: 20 },
      });
    }) as unknown as typeof fetch;
    const { llm, db } = await router(fetchImpl);
    const d = await llm.decide("reply_classify", "Please remove me", Q);
    expect(d.answers.label).toMatchObject({ choice: "unsubscribe", confidence: 0.97 });
    expect(d.costUsd).toBeCloseTo((0.042 * 1000) / 1e6, 12); // output tokens are free
    const [call] = await db.select().from(llmCalls);
    expect(call).toMatchObject({ task: "reply_classify", provider: "jev", model: "jev-latest", ok: true });
  });

  it("retries 429s and rejects answers outside the criteria", async () => {
    let n = 0;
    const flaky = (async () => (++n === 1 ? json({ error: "slow down" }, 429) : json({ model: "jev", answers: { label: { type: "choice", choice: "interested", confidence: 0.8, probabilities: {} }, whole_firm: { type: "noul", noul: 0 } } }))) as unknown as typeof fetch;
    const a = await router(flaky);
    expect((await a.llm.decide("reply_classify", "Sure, let's talk", Q)).answers.label).toMatchObject({ choice: "interested" });
    expect(n).toBe(2);
    await close();

    const bogus = (async () => json({ answers: { label: { type: "choice", choice: "maybe", confidence: 1, probabilities: {} }, whole_firm: { type: "noul", noul: 0 } } })) as unknown as typeof fetch;
    const b = await router(bogus);
    await expect(b.llm.decide("reply_classify", "x", Q)).rejects.toBeInstanceOf(LlmExhaustedError);
  });
});

describe("reply classification: Jev first, gpt-6-luna when unsure", () => {
  let ctx: TestCtx;
  afterEach(async () => ctx?.close());
  const generative = (label: string) => ({ label, confidence: 0.9, summary: "llm", referral: null, ooo_until: null, remove_whole_company: false });

  it("uses Jev's label when confident and extracts details without an LLM", async () => {
    const llm = new FakeLlm().onDecide("reply_classify", () => ({
      label: { type: "choice", choice: "referral", confidence: 0.93, probabilities: {} },
      whole_firm: { type: "noul", noul: 0.05 },
    }));
    ctx = await createTestCtx({ llm });
    const r = await classifyReply(ctx, { subject: "Re: billing", body: "Talk to Dana instead: dana@rivera.biz.example", classifiedBy: null, fromEmail: "ana@rivera.biz.example" });
    expect(r).toMatchObject({ label: "referral", confidence: 0.93, by: "decision:fake-jev", removeWholeCompany: false });
    expect(r.referral?.email).toBe("dana@rivera.biz.example");
    expect(llm.calls).toHaveLength(0); // no generation spent
    expect(llm.decisionCalls[0]!.questions.label).toMatchObject({ type: "choice" });
  });

  it("asks gpt-6-luna (escalation route) when Jev is unsure", async () => {
    const llm = new FakeLlm()
      .onDecide("reply_classify", () => ({ label: { type: "choice", choice: "other", confidence: 0.35, probabilities: {} }, whole_firm: { type: "noul", noul: 0.2 } }))
      .on("reply_classify_escalate", () => generative("objection"));
    ctx = await createTestCtx({ llm });
    const r = await classifyReply(ctx, { subject: "Re: x", body: "We tried two tools already, not sure yours is different.", classifiedBy: null, fromEmail: "a@b.example" });
    expect(r.label).toBe("objection");
    expect(llm.calls.map((c) => c.task)).toEqual(["reply_classify_escalate"]);
  });

  it("whole-company opt-outs come from Jev's noul answer", async () => {
    const llm = new FakeLlm().onDecide("reply_classify", () => ({ label: { type: "choice", choice: "unsubscribe", confidence: 0.9, probabilities: {} }, whole_firm: { type: "noul", noul: 0.88 } }));
    ctx = await createTestCtx({ llm });
    const r = await classifyReply(ctx, { subject: "Re: x", body: "Not interested. Don't contact anyone else here either, thanks.", classifiedBy: null, fromEmail: "a@b.example" });
    expect(r).toMatchObject({ label: "unsubscribe", removeWholeCompany: true });
  });

  it("segment tagging in qualify uses Jev", async () => {
    const llm = new FakeLlm().onDecide("lead_tagging", (_state, q) => {
      expect(Object.keys((q.segment as { criteria: Record<string, string> }).criteria)).toContain("none");
      return { segment: { type: "choice", choice: "landscaping", confidence: 0.82, probabilities: {} } };
    });
    ctx = await createTestCtx({ llm });
    await ctx.db.insert(companies).values({ domain: "hart.example", name: "Hart & Cole", state: "OH", companySize: 3, source: "test" });
    expect(await runQualify(ctx)).toEqual({ qualified: 1, disqualified: 0 });
    const [c] = await ctx.db.select().from(companies);
    expect(c!.segmentId).toBe("landscaping");
  });
});

describe("AI Ark lead source", () => {
  let ctx: TestCtx;
  afterEach(async () => ctx?.close());

  const person = (id: string, domain: string, title: string, first: string) => ({
    id,
    profile: { first_name: first, last_name: "Lee", full_name: `${first} Lee`, title },
    link: { linkedin: `https://www.linkedin.com/in/${id}` },
    location: { country: "United States", state: "Texas", city: "Austin" },
    company: { id: `co-${domain}`, summary: { name: `${domain} Services`, staff: { total: 4 } }, link: { domain } },
  });

  function fakeArk() {
    const calls: { path: string; body: any; token: string }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init!.body));
      calls.push({ path, body, token: (init!.headers as Record<string, string>)["X-TOKEN"]! });
      if (path.endsWith("/v1/people")) {
        return json({
          content: [
            person("p1", "lee-family.biz.example", "Service Technician", "Sam"),
            person("p2", "lee-family.biz.example", "General Manager", "Ana"),
            { ...person("p3", "oak-heating.biz.example", "Owner", "Bo"), location: { country: "United States", state: null, city: "Greater Richmond Region" }, company: { id: "co-oak", summary: { name: "Oak Heating", staff: { total: 3 } }, link: { domain: "oak-heating.biz.example" }, location: { headquarter: { country: "United States", state: "Virginia", city: "Richmond" } } } },
          ],
          totalPages: 1,
          trackId: "t",
        });
      }
      if (path.endsWith("/people/export/single")) {
        if (body.id === "p2") return json({ message: "no email found" }, 404); // not charged
        return json({ profile: {}, email: { state: "DONE", output: [{ address: body.id === "p1" ? "sam@lee-family.biz.example" : "bo@oak-heating.biz.example", status: "SMTP", found: true }] } });
      }
      return json({}, 400);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("searches small US companies, buys one email per company (best role first), and tracks credits", async () => {
    ctx = await createTestCtx();
    const { calls, fetchImpl } = fakeArk();
    const spent: number[] = [];
    const cursor = new MemoryCursorStore();
    const src = new AiArkSource({
      apiKey: "ark-key",
      termsAllowOutbound: true,
      maxCreditsPerRun: 50,
      maxExportsPerCompany: 2,
      employeeMin: 1,
      employeeMax: 20,
      industries: ["construction"],
      cursor,
      onSpend: (c) => void spent.push(c),
      fetchImpl,
      sleep: async () => {},
    });
    const stats = await runDiscover(ctx, [src], { segmentId: "hvac", limitPerSegment: 10 });
    expect(stats.companiesNew).toBe(2);
    expect(stats.contactsNew).toBe(2);

    const search = calls.find((c) => c.path.endsWith("/v1/people"))!;
    expect(search.token).toBe("ark-key");
    expect(search.body.account.employeeSize).toEqual({ type: "RANGE", range: [{ start: 1, end: 20 }] });
    expect(search.body.account.location.any.include).toEqual(["United States"]);
    expect(search.body.account.keyword.any.include.content).toContain("hvac");
    expect(search.body.contact.experience.latest.title.any.include.content).toContain("general manager");

    // Managing partner tried first (no email, free), then the associate.
    const exports = calls.filter((c) => c.path.endsWith("/export/single")).map((c) => c.body.id);
    expect(exports.slice(0, 2)).toEqual(["p2", "p1"]);
    const people = await ctx.db.select().from(contacts);
    expect(people.map((p) => p.email).sort()).toEqual(["bo@oak-heating.biz.example", "sam@lee-family.biz.example"]);
    expect(people.every((p) => p.source === "ai_ark" && p.sourceUrl?.startsWith("https://www.linkedin.com/in/"))).toBe(true);
    const [company] = await ctx.db.select().from(companies).where(eq(companies.domain, "lee-family.biz.example"));
    expect(company).toMatchObject({ state: "Texas", companySize: 4, focusAreas: ["hvac"] });
    // No state on the person: the company's HQ supplies it (needed for the recipient's time zone).
    const [oak] = await ctx.db.select().from(companies).where(eq(companies.domain, "oak-heating.biz.example"));
    expect(oak).toMatchObject({ state: "Virginia", city: "Richmond" });

    // 3 search results x 0.5 + 2 emails found x 0.5 = 2.5 credits; 404s cost nothing.
    expect(spent.reduce((a, b) => a + b, 0)).toBe(2.5);
    expect(src.creditsUsed).toBe(2.5);
    expect(await cursor.get("ai_ark:page:hvac")).toBe(1);
  });

  it("respects the per-run credit budget and the terms gate", async () => {
    ctx = await createTestCtx();
    const { calls, fetchImpl } = fakeArk();
    const tight = new AiArkSource({ apiKey: "k", termsAllowOutbound: true, maxCreditsPerRun: 4, maxExportsPerCompany: 2, employeeMin: 1, employeeMax: 20, industries: ["construction"], fetchImpl, sleep: async () => {} });
    await runDiscover(ctx, [tight], { segmentId: "hvac", limitPerSegment: 10 });
    expect(calls).toHaveLength(0); // 4 credits can't cover a minimum search page (10 x 0.5)

    const gated = new AiArkSource({ apiKey: "k", termsAllowOutbound: false, maxCreditsPerRun: 50, maxExportsPerCompany: 2, employeeMin: 1, employeeMax: 20, industries: ["construction"], fetchImpl, sleep: async () => {} });
    const stats = await runDiscover(ctx, [gated], { segmentId: "hvac" });
    expect(stats.skipped.source_terms).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
