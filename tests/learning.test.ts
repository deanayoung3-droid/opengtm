import { events, messages, recordEvent, replies, segments, sequenceSteps, threads } from "@opengtm/core";
import { createTestCtx, FakeLlm, type TestCtx } from "@opengtm/core/testing";
import { activateVariant, buildWeeklyDigest, runSegmentGuards, runVariantTests, runWeeklyDigest, segmentFunnel, twoProportionTest } from "@opengtm/learning";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { seedCompany, seedMailbox, seedSequence } from "./fixtures";

/** Bulk-create sent step-1 threads for a variant, `positive` of which got an interested reply. */
async function sentThreads(ctx: TestCtx, campaignId: string, mailboxId: string, variant: string, n: number, positive: number) {
  for (let i = 0; i < n; i++) {
    const company = await seedCompany(ctx, { withFacts: false });
    const [t] = await ctx.db.insert(threads).values({ contactId: company.contact.id, companyId: company.company.id, campaignId, mailboxId, variant, status: "active" }).returning();
    const [m] = await ctx.db
      .insert(messages)
      .values({ threadId: t!.id, contactId: company.contact.id, stepNumber: 1, variant, subject: "s", body: "b", status: "sent", sentAt: ctx.clock.now(), approvalState: "approved", rfcMessageId: `<${t!.id}@x>`, mailboxId, costUsd: 0.05 })
      .returning();
    await recordEvent(ctx.db, "sent", { messageId: m!.id, mailboxId, segmentId: "hvac", at: ctx.clock.now() });
    if (i < positive) {
      await ctx.db.insert(replies).values({ threadId: t!.id, messageId: m!.id, contactId: company.contact.id, mailboxId, fromEmail: company.contact.email, body: "yes, let's talk", receivedAt: ctx.clock.now(), label: "interested", rfcMessageId: `<r${t!.id}@x>` });
    }
  }
}

describe("learning loop", () => {
  let ctx: TestCtx;
  afterEach(async () => ctx?.close());

  it("two-proportion test matches known values", () => {
    const { p } = twoProportionTest(30, 200, 12, 200);
    expect(p).toBeGreaterThan(0.002);
    expect(p).toBeLessThan(0.005);
    expect(twoProportionTest(10, 100, 10, 100).p).toBeCloseTo(1, 5);
  });

  it("retires a significantly worse variant and proposes a challenger for human review", async () => {
    const llm = new FakeLlm().on("segment_insights", () => ({
      rationale: "Lead with customer reminders; it drove the winning replies.",
      steps: [1, 2, 3, 4].map((step) => ({ step, instructions: `Challenger step ${step}: lead with customer reminders.` })),
    }));
    ctx = await createTestCtx({ llm });
    const { campaign, sequence } = await seedSequence(ctx);
    const mb = await seedMailbox(ctx);
    await sentThreads(ctx, campaign.id, mb.id, "A", 110, 18);
    await sentThreads(ctx, campaign.id, mb.id, "B", 110, 3);

    const [d] = await runVariantTests(ctx);
    expect(d!.winner).toBe("A");
    expect(d!.loser).toBe("B");
    expect(d!.p!).toBeLessThan(0.05);
    expect(d!.proposed).toBe("C");
    const steps = await ctx.db.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, sequence.id));
    expect(steps.filter((s) => s.variant === "B").every((s) => s.status === "retired")).toBe(true);
    expect(steps.filter((s) => s.variant === "C").every((s) => s.status === "proposed")).toBe(true);
    expect(ctx.sink.alerts.some((a) => a.title.includes("challenger variant C"))).toBe(true);

    await activateVariant(ctx, sequence.id, "C", "dean");
    const c = await ctx.db.select().from(sequenceSteps).where(and(eq(sequenceSteps.sequenceId, sequence.id), eq(sequenceSteps.variant, "C")));
    expect(c.every((s) => s.status === "active")).toBe(true);
  }, 120_000);

  it("does nothing without enough data", async () => {
    ctx = await createTestCtx({ llm: new FakeLlm() });
    const { campaign } = await seedSequence(ctx);
    const mb = await seedMailbox(ctx);
    await sentThreads(ctx, campaign.id, mb.id, "A", 20, 5);
    await sentThreads(ctx, campaign.id, mb.id, "B", 20, 0);
    const [d] = await runVariantTests(ctx);
    expect(d!.winner).toBeUndefined();
  });

  it("auto-pauses a segment after 150 sends with zero positive replies", async () => {
    ctx = await createTestCtx({ llm: new FakeLlm() });
    const { campaign } = await seedSequence(ctx);
    const mb = await seedMailbox(ctx);
    await sentThreads(ctx, campaign.id, mb.id, "A", 150, 0);
    const res = await runSegmentGuards(ctx);
    expect(res.paused).toEqual(["hvac"]);
    const [s] = await ctx.db.select().from(segments).where(eq(segments.id, "hvac"));
    expect(s!.status).toBe("paused");
    expect(ctx.sink.alerts.some((a) => a.key === "segment_paused:hvac")).toBe(true);
  }, 120_000);

  it("funnel and weekly digest come from real data; the model only adds recommendations", async () => {
    const llm = new FakeLlm().on("segment_insights", (input) => {
      expect(input.prompt).toContain('"segmentId": "hvac"');
      return { headline: "Family law is replying; keep going.", top_segments: ["hvac"], worst_segments: [], actions: ["Approve pending drafts daily"] };
    });
    ctx = await createTestCtx({ llm });
    const { campaign } = await seedSequence(ctx);
    const mb = await seedMailbox(ctx);
    await sentThreads(ctx, campaign.id, mb.id, "A", 12, 2);
    const funnel = await segmentFunnel(ctx);
    const fam = funnel.find((f) => f.segmentId === "hvac")!;
    expect(fam).toMatchObject({ emailed: 12, sends: 12, replied: 2, positive: 2 });

    let mailed = "";
    const md = await runWeeklyDigest(ctx, async (_s, text) => {
      mailed = text;
    });
    expect(md).toContain("Family law is replying");
    expect(md).toContain("| hvac | active |");
    expect(mailed).toBe(md);
    expect((await ctx.db.select().from(events).where(eq(events.type, "digest"))).length).toBe(1);

    // Without a model the digest still goes out with the numbers.
    ctx.llm = new FakeLlm();
    const { LlmExhaustedError } = await import("@opengtm/core");
    (ctx.llm as FakeLlm).on("segment_insights", () => {
      throw new LlmExhaustedError("segment_insights", ["down"]);
    });
    const fallback = await buildWeeklyDigest(ctx);
    expect(fallback.markdown).toContain("Recommendations unavailable");
  });
});
