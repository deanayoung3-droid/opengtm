import { contacts, messages, sequenceSteps, setSetting, threads } from "@opengtm/core";
import { ensureDefaultCampaigns, runSchedule } from "@opengtm/sequencer";
import { createTestCtx, FakeLlm, testConfig, type TestCtx } from "@opengtm/core/testing";
import { ApprovalError, approveMessage, checkStep, decideApproval, recheckHeld, recheckSettingsBlocked, redraftHeld, redraftThread, refreshFollowups, rejectMessage, writeThread } from "@opengtm/writer";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { goodBody, goodDraft, passingCritic, seedThread } from "./fixtures";

describe("writer + critic + compliance + approval", () => {
  let ctx: TestCtx;
  let llm: FakeLlm;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined as unknown as TestCtx;
  });

  /** A second thread: another person at the same company, from the same mailbox. */
  async function anotherThread(w: Awaited<ReturnType<typeof seedThread>>) {
    const [person] = await ctx.db
      .insert(contacts)
      .values({ companyId: w.company.id, email: `p${Date.now() % 1e6}@${w.company.domain}`, firstName: "Sam", source: "test", status: "verified", verifyStatus: "valid", mailProvider: "google" })
      .returning();
    const [thread] = await ctx.db
      .insert(threads)
      .values({ contactId: person!.id, companyId: w.company.id, campaignId: w.campaign.id, mailboxId: w.mailbox.id, variant: "A" })
      .returning();
    return { ...w, thread: thread! };
  }

  async function setup(config = testConfig(), opts: { withFacts?: boolean } = {}) {
    llm = new FakeLlm().on("critic", passingCritic);
    ctx = await createTestCtx({ llm, config });
    return seedThread(ctx, opts);
  }

  it("drafts a 4-step sequence with traceable facts, footer, and prompt version", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f2"]));
    const out = await writeThread(ctx, w.thread.id);
    expect(out.status).toBe("drafted");
    expect(out.issues).toEqual([]);

    const rows = await ctx.db.select().from(messages).where(eq(messages.threadId, w.thread.id)).orderBy(asc(messages.stepNumber));
    expect(rows.map((r) => r.stepNumber)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.dayOffset)).toEqual([0, 3, 7, 14]);
    expect(rows[0]!.subject).toBe("scheduling at your company");
    expect(rows[1]!.subject).toBe("Re: scheduling at your company");
    // f2 resolved to the real fact UUID with its source URL recorded.
    const hiringFact = w.facts.find((f) => f.text.includes("dispatcher"))!;
    expect(rows[0]!.factIds).toEqual([hiringFact.id]);
    expect((rows[0]!.qaVerdict as any).factSources[hiringFact.id]).toBe(hiringFact.sourceUrl);
    expect(rows[1]!.proofPointIds).toEqual(["pp1"]);
    for (const r of rows) {
      expect(r.promptVersion).toBe("write_email@v1");
      expect(r.body).toContain("100 Example Ave, Suite 1, Austin, TX 78701");
      expect(r.body).toContain('Reply "stop"');
      expect(r.body).toContain("Jamie Rivera");
      expect(r.body).toContain("Northwind");
      expect(r.approvalState).toBe("pending"); // force_all is on by default
    }
  });

  it("moves the stored sequence to a new config once (4 steps -> OtherTool's 2) and cancels unsent extra steps", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f2"]));
    await writeThread(ctx, w.thread.id);
    ctx.config.engine.sequence.steps = [{ step: 1, day: 0 }, { step: 2, day: 3 }];
    await ensureDefaultCampaigns(ctx);
    const steps = await ctx.db.select().from(sequenceSteps);
    expect(steps.filter((x) => x.status === "active").map((x) => x.stepNumber).sort()).toEqual([1, 1, 2, 2]); // variants A and B
    const msgs = await ctx.db.select().from(messages).where(eq(messages.threadId, w.thread.id)).orderBy(asc(messages.stepNumber));
    expect(msgs.map((m) => m.status)).toEqual(["draft", "draft", "cancelled", "cancelled"]);

    // Applied once: a later change on the Email sequence page is not overwritten on the next run.
    await ctx.db.update(sequenceSteps).set({ status: "active" }).where(eq(sequenceSteps.stepNumber, 3));
    await ensureDefaultCampaigns(ctx);
    expect((await ctx.db.select().from(sequenceSteps)).filter((x) => x.stepNumber === 3).every((x) => x.status === "active")).toBe(true);
  });

  // Decided 2026-11-01: the plain follow-up goes a week after the first email, including ones already queued.
  it("moving the follow-up to day 7 also moves follow-ups already written or scheduled", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f2"]));
    await writeThread(ctx, w.thread.id);
    ctx.config.engine.sequence.steps = [{ step: 1, day: 0 }, { step: 2, day: 3 }];
    await ensureDefaultCampaigns(ctx);
    // Step 1 went out; step 2 was scheduled three days later.
    const sentAt = ctx.clock.now();
    const step = async (n: number) => (await ctx.db.select().from(messages).where(and(eq(messages.threadId, w.thread.id), eq(messages.stepNumber, n))))[0]!;
    await ctx.db.update(messages).set({ status: "sent", sentAt }).where(eq(messages.id, (await step(1)).id));
    await ctx.db.update(messages).set({ status: "scheduled", scheduledFor: new Date(sentAt.getTime() + 3 * 86_400_000), approvalState: "auto_approved" }).where(eq(messages.id, (await step(2)).id));

    ctx.config.engine.sequence.steps = [{ step: 1, day: 0 }, { step: 2, day: 7 }];
    await ensureDefaultCampaigns(ctx);
    expect(await step(2)).toMatchObject({ dayOffset: 7, status: "draft", scheduledFor: null });
    await ctx.db.update(threads).set({ status: "active" }).where(eq(threads.id, w.thread.id));
    await runSchedule(ctx);
    const planned = await step(2);
    expect(planned.status).toBe("scheduled");
    expect(planned.scheduledFor!.getTime() - sentAt.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000);
    expect((await ctx.db.select().from(sequenceSteps)).filter((x) => x.stepNumber === 2).every((x) => x.dayOffset === 7)).toBe(true);
  });

  it("releases drafts that were held only for a missing setting once it is filled in", async () => {
    const config = testConfig((raw) => {
      raw.business.company.physical_address = "";
      raw.engine.approval = { require_first_n: 0, sample_rate: 0, force_all: false };
    });
    const w = await setup(config);
    llm.on("write_email", () => goodDraft(["f2"]));
    expect((await writeThread(ctx, w.thread.id)).status).toBe("needs_review");
    const held = await ctx.db.select().from(messages).where(eq(messages.threadId, w.thread.id));
    expect(held.every((m) => m.approvalState === "needs_review")).toBe(true);
    expect(await recheckSettingsBlocked(ctx)).toEqual({ released: 0, stillHeld: 4 }); // still no address

    ctx.config.business.company.physical_address = "300 Creek View Rd, Suite 209, Newark, DE 19711";
    expect(await recheckSettingsBlocked(ctx)).toEqual({ released: 4, stillHeld: 0 });
    const after = await ctx.db.select().from(messages).where(eq(messages.threadId, w.thread.id));
    expect(after.every((m) => m.approvalState === "auto_approved" && m.body.includes("300 Creek View Rd"))).toBe(true);
    expect(after.every((m) => m.body.split("\nBest,\n").length === 2)).toBe(true); // one footer, not two
  });

  it("rejects a message citing a fact that is not in the store (regenerates, then flags for review)", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f9"]));
    const out = await writeThread(ctx, w.thread.id);
    expect(llm.calls.filter((c) => c.task === "write_email")).toHaveLength(3); // 1 + 2 regenerations
    expect(out.status).toBe("needs_review");
    expect(out.issues.map((i) => i.code)).toContain("unknown_fact");
    const [first] = await ctx.db.select().from(messages).where(eq(messages.stepNumber, 1));
    expect(first!.approvalState).toBe("needs_review");
    expect(first!.factIds).toEqual([]); // unknown alias never becomes a stored reference
  });

  it("rejects banned claims", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f2"], { 2: goodBody(2, "Results are guaranteed for every company.") }));
    const out = await writeThread(ctx, w.thread.id);
    expect(out.status).toBe("needs_review");
    expect(out.issues.some((i) => i.code === "banned_claim" && i.message.includes("guaranteed"))).toBe(true);
  });

  it("enforces word count", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f2"], { 3: "Hi Ana, quick question: worth a look?" }));
    const out = await writeThread(ctx, w.thread.id);
    expect(out.issues.some((i) => i.code === "word_count" && i.message.startsWith("step 3"))).toBe(true);
  });

  it("regenerates with feedback and accepts a fixed draft", async () => {
    const w = await setup();
    let n = 0;
    llm.on("write_email", () => (++n === 1 ? goodDraft(["f2"], { 1: goodBody(1, "Act now, this is urgent.") }) : goodDraft(["f2"])));
    const out = await writeThread(ctx, w.thread.id);
    expect(out.status).toBe("drafted");
    expect(out.attempts).toBe(2);
    const second = llm.calls.filter((c) => c.task === "write_email")[1]!;
    expect(second.input.prompt).toContain("previous draft was rejected");
    expect(second.input.prompt).toMatch(/act now/i);
  });

  it("blocks critic-flagged unsupported claims", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f2"]));
    llm.on("critic", () => ({ score: 70, problems: [{ step: 2, kind: "unsupported_claim", text: "claims Northwind saves hours weekly" }] }));
    const out = await writeThread(ctx, w.thread.id);
    expect(out.status).toBe("needs_review");
    expect(out.issues.map((i) => i.code)).toContain("critic_unsupported_claim");
  });

  it("falls back to segment-level copy when there are no facts", async () => {
    const w = await setup(testConfig(), { withFacts: false });
    llm.on("write_email", (input) => {
      expect(input.prompt).toContain("no researched facts");
      return goodDraft([]);
    });
    const out = await writeThread(ctx, w.thread.id);
    expect(out.status).toBe("drafted");
  });

  it("deterministic rules: numbers must be cited, one question, no links in step 1, no fake familiarity", () => {
    const rc = {
      facts: new Map([["f1", "Founded in 2009"]]),
      proofPoints: new Map([["pp1", "Flat pricing"]]),
      bannedClaims: [],
      minWords: 5,
      maxWords: 90,
      bookingLink: "https://cal.example.com/northwind-intro",
    };
    const codes = (step: number, body: string, f: string[] = []) => checkStep({ step, body, fact_ids: f, proof_point_ids: [] }, rc).map((i) => i.code);
    expect(codes(1, "Your company has 12 technicians, right?")).toContain("unsupported_number");
    expect(codes(1, "Founded in 2009, impressive work there friend?", ["f1"])).not.toContain("unsupported_number");
    expect(codes(1, "As we discussed last week, ready to talk?")).toContain("fake_familiarity");
    expect(codes(1, "See https://northwind.example.com for the details, ok?")).toContain("link_in_step1");
    expect(codes(3, "Grab a time at https://cal.example.com/northwind-intro whenever you like, ok?")).not.toContain("link_not_allowed");
    expect(codes(3, "Read https://evil.example.com/x before deciding anything here, ok?")).toContain("link_not_allowed");
    // Step 2 is a plain nudge for people who never replied: no links at all, not even the booking link.
    expect(codes(2, "Would a free preview of Northwind be useful? Book here: https://cal.example.com/northwind-intro")).toContain("link_in_step2");
    expect(codes(2, "Quick follow-up on my last note. Would a free preview of Northwind be useful?")).toEqual([]);
    expect(codes(2, "Try the interactive demo at northwind.example.com, would that help?")).toContain("demo_in_step2");
    // Later steps (and replies) may still point to the demo.
    expect(codes(3, "Try the interactive demo at northwind.example.com, would that help?")).not.toContain("demo_in_step2");
    expect(codes(1, "Two questions? Really two questions here?")).toContain("question_cta");
    expect(codes(1, "<p>Hello</p> there friend, how are you?")).toContain("not_plain_text");
  });

  it("compliance blocks sending when the physical address is missing", async () => {
    const cfg = testConfig((raw) => (raw.business.company.physical_address = ""));
    const w = await setup(cfg);
    llm.on("write_email", () => goodDraft(["f2"]));
    const out = await writeThread(ctx, w.thread.id);
    expect(out.status).toBe("needs_review");
    expect(out.issues.map((i) => i.code)).toContain("config_missing");
  });

  it("approval policy: first N, critic threshold, sampling, and global force switch", async () => {
    const cfg = testConfig((raw) => {
      raw.engine.approval.force_all = false;
      raw.engine.approval.require_first_n = 0;
      raw.engine.approval.sample_rate = 0.1;
    });
    await setup(cfg);
    let r = 0.5;
    ctx.random = () => r;
    expect((await decideApproval(ctx, { passed: true, score: 90 })).state).toBe("auto_approved");
    expect((await decideApproval(ctx, { passed: true, score: 50 })).state).toBe("pending");
    expect((await decideApproval(ctx, { passed: false, score: 90 })).state).toBe("needs_review");
    r = 0.05;
    expect(await decideApproval(ctx, { passed: true, score: 90 })).toMatchObject({ state: "pending", sampled: true });
    r = 0.5;
    await setSetting(ctx.db, "force_approval", true);
    expect((await decideApproval(ctx, { passed: true, score: 90 })).state).toBe("pending");

    const strict = testConfig((raw) => {
      raw.engine.approval.force_all = false;
      raw.engine.approval.require_first_n = 100;
    });
    ctx.config = strict;
    await setSetting(ctx.db, "force_approval", null);
    expect((await decideApproval(ctx, { passed: true, score: 90 })).reason).toContain("first 100");
  });

  it("human edits are re-checked; rejection stops the thread", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f2"]));
    await writeThread(ctx, w.thread.id);
    const rows = await ctx.db.select().from(messages).where(eq(messages.threadId, w.thread.id)).orderBy(asc(messages.stepNumber));
    const step1 = rows[0]!;
    const withLink = step1.body.replace("Would it be worth", "See https://northwind.example.com. Would it be worth");
    await expect(approveMessage(ctx, step1.id, "dean", { body: withLink })).rejects.toBeInstanceOf(ApprovalError);
    await approveMessage(ctx, step1.id, "dean", { body: step1.body.replace("a short conversation", "a short call") });
    const [approved] = await ctx.db.select().from(messages).where(eq(messages.id, step1.id));
    expect(approved!.approvalState).toBe("approved");
    expect(approved!.body).toContain("a short call");

    await rejectMessage(ctx, rows[1]!.id, "dean", "tone");
    const after = await ctx.db.select().from(messages).where(eq(messages.threadId, w.thread.id));
    expect(after.filter((m) => m.status === "draft").length).toBe(0);
  });

  it("accepts a step a few words over the target (models miscount), and gives no score when the reviewer never read it", async () => {
    const w = await setup();
    const long = (n: number) => goodBody(1, Array.from({ length: n }, () => "plainly").join(" ") + ".");
    const base = goodBody(1).split(/\s+/).length;
    llm.on("write_email", () => goodDraft(["f2"], { 1: long(95 - base) }));
    const ok = await writeThread(ctx, w.thread.id);
    expect(ok.issues.filter((i) => i.code === "word_count")).toEqual([]);

    const w2 = await anotherThread(w);
    llm.on("write_email", () => goodDraft(["f2"], { 1: long(105 - base) }));
    const over = await writeThread(ctx, w2.thread.id);
    expect(over.issues.some((i) => i.code === "word_count" && i.message.includes("allowed 50-100"))).toBe(true);
    const [held] = await ctx.db.select().from(messages).where(eq(messages.threadId, w2.thread.id)).orderBy(asc(messages.stepNumber));
    expect(held!.qaScore).toBeNull();
  });

  it("the reviewer knows the offer, every proof point and the recipient record", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f2"]));
    await writeThread(ctx, w.thread.id);
    const call = llm.calls.find((c) => c.task === "critic")!;
    expect(call.input.prompt).toContain(`The offer (the call to action): ${ctx.config.business.company.offer || "(none)"}`);
    expect(call.input.prompt).toContain(w.company.name);
    for (const p of ctx.config.proofPoints) expect(call.input.prompt).toContain(p.text);
  });

  it("held drafts are reviewed again once under new rules: passing ones are released, the rest keep today's reasons", async () => {
    const cfg = testConfig((raw) => {
      raw.engine.approval.force_all = false;
      raw.engine.approval.require_first_n = 0;
      raw.engine.approval.sample_rate = 0;
    });
    const a = await setup(cfg);
    const b = await anotherThread(a);
    llm.on("write_email", () => goodDraft(["f2"]));
    llm.on("critic", () => ({ score: 85, problems: [{ step: 1, kind: "unsupported_claim", text: "a free preview is not in the cited block" }] }));
    expect((await writeThread(ctx, a.thread.id)).status).toBe("needs_review");
    expect((await writeThread(ctx, b.thread.id)).status).toBe("needs_review");
    // Make them look like drafts reviewed under the old rules.
    for (const m of await ctx.db.select().from(messages)) {
      const { reviewVersion: _old, ...v } = m.qaVerdict as Record<string, unknown>;
      await ctx.db.update(messages).set({ qaVerdict: v }).where(eq(messages.id, m.id));
    }

    let n = 0;
    llm.on("critic", () => (++n === 1 ? { score: 88, problems: [] } : { score: 60, problems: [{ step: 2, kind: "unsupported_claim", text: "invents a probate module" }] }));
    const first = await recheckHeld(ctx);
    expect(first.released).toBe(4);
    expect(first.stillHeld).toBe(4);
    const all = await ctx.db.select().from(messages).orderBy(asc(messages.stepNumber));
    const states = (id: string) => all.filter((m) => m.threadId === id && m.status === "draft").map((m) => m.approvalState);
    const [releasedId, heldId] = states(a.thread.id).includes("auto_approved") ? [a.thread.id, b.thread.id] : [b.thread.id, a.thread.id];
    expect(states(releasedId)).toEqual(["auto_approved", "auto_approved", "auto_approved", "auto_approved"]);
    expect(states(heldId)).toEqual(["needs_review", "needs_review", "needs_review", "needs_review"]);
    const heldStep2 = all.find((m) => m.threadId === heldId && m.stepNumber === 2)!;
    expect((heldStep2.qaVerdict as any).issues.map((i: any) => i.message)).toEqual(["step 2: invents a probate module"]);
    expect(heldStep2.qaScore).toBe(60);

    const criticCalls = llm.calls.filter((c) => c.task === "critic").length;
    expect(await recheckHeld(ctx)).toEqual({ released: 0, stillHeld: 0 }); // once per rules version
    expect(llm.calls.filter((c) => c.task === "critic").length).toBe(criticCalls);
  });

  it("a held sequence is rewritten once with its reasons; only one still flagged after that waits for a person", async () => {
    const cfg = testConfig((raw) => {
      raw.engine.approval.force_all = false;
      raw.engine.approval.require_first_n = 0;
      raw.engine.approval.sample_rate = 0;
    });
    const a = await setup(cfg);
    const b = await anotherThread(a);
    llm.on("write_email", () => goodDraft(["f2"]));
    llm.on("critic", () => ({ score: 80, problems: [{ step: 1, kind: "unsupported_claim", text: "says the company does hvac" }] }));
    await writeThread(ctx, a.thread.id);
    await writeThread(ctx, b.thread.id);

    // The rewrite of A passes; B's is flagged again.
    llm.on("critic", (input) => (input.prompt.includes("Sam") ? { score: 80, problems: [{ step: 2, kind: "unsupported_claim", text: "invents a probate module" }] } : { score: 84, problems: [] }));
    const out = await redraftHeld(ctx);
    expect(out.map((o) => o.status).sort()).toEqual(["drafted", "needs_review"]);
    const rewrite = llm.calls.filter((c) => c.task === "write_email").at(-1)!;
    expect(rewrite.input.prompt).toContain("held back for these reasons");
    expect(rewrite.input.prompt).toContain("says the company does hvac");

    const msgs = await ctx.db.select().from(messages).where(eq(messages.status, "draft"));
    expect(msgs.filter((m) => m.threadId === a.thread.id).every((m) => m.approvalState === "auto_approved")).toBe(true);
    const stillHeld = msgs.filter((m) => m.threadId === b.thread.id);
    expect(stillHeld.every((m) => m.approvalState === "needs_review" && (m.qaVerdict as any).round === 2)).toBe(true);

    // Only once: the second-round draft is left for a person.
    expect(await redraftHeld(ctx)).toEqual([]);
  });

  it("a held sequence that already started sending, or held only for a missing setting, is not rewritten", async () => {
    const w = await setup();
    llm.on("write_email", () => goodDraft(["f2"]));
    llm.on("critic", () => ({ score: 80, problems: [{ step: 2, kind: "unsupported_claim", text: "x" }] }));
    await writeThread(ctx, w.thread.id);
    const [first] = await ctx.db.select().from(messages).where(eq(messages.stepNumber, 1));
    await ctx.db.update(messages).set({ status: "sent" }).where(eq(messages.id, first!.id));
    expect(await redraftThread(ctx, w.thread.id)).toBeNull();
    await ctx.db.update(messages).set({ status: "draft" }).where(eq(messages.id, first!.id));
    for (const m of await ctx.db.select().from(messages)) {
      await ctx.db.update(messages).set({ qaVerdict: { ...(m.qaVerdict as object), issues: [{ code: "missing_address", message: "step 1: no postal address" }] } }).where(eq(messages.id, m.id));
    }
    expect(await redraftHeld(ctx)).toEqual([]);
  });

  it("unsent follow-ups from an older prompt are rewritten once after the first email; a person's approval and a failing rewrite keep the old text", async () => {
    const cfg = testConfig((raw) => {
      raw.engine.approval.force_all = false;
      raw.engine.approval.require_first_n = 0;
      raw.engine.approval.sample_rate = 0;
    });
    const a = await setup(cfg);
    const b = await anotherThread(a);
    llm.on("write_email", () => goodDraft(["f2"]));
    await writeThread(ctx, a.thread.id);
    await writeThread(ctx, b.thread.id);
    // Written under the old prompt; A's first email went out, and a person approved B's step 3.
    await ctx.db.update(messages).set({ promptVersion: "write_email@v0" });
    await ctx.db.update(threads).set({ status: "active" });
    await ctx.db.update(messages).set({ status: "sent" }).where(and(eq(messages.threadId, a.thread.id), eq(messages.stepNumber, 1)));
    await ctx.db.update(messages).set({ approvalState: "approved", approvedBy: "dashboard:dean" }).where(and(eq(messages.threadId, b.thread.id), eq(messages.stepNumber, 3)));

    const nudge =
      "Hi Ana,\n\nQuick follow-up on my last note.\n\nNorthwind keeps scheduling, reminders and invoices in one place, without the setup most scheduling tools need.\n\nWould a free preview of Northwind be useful for your company? Just reply \"yes\" and I'll send it over.";
    llm.on("write_email", (input) => {
      const steps = [...input.prompt.matchAll(/^Step (\d) \(day/gm)].map((m) => Number(m[1]));
      // B's rewrite keeps adding a link (not allowed in step 2), so B keeps its old follow-ups.
      const step2 = input.prompt.includes("Sam") ? `${nudge} https://cal.example.com/northwind-intro` : nudge;
      return { subject: "scheduling at your company", steps: steps.map((step) => ({ step, body: step === 2 ? step2 : goodBody(step), fact_ids: [], proof_point_ids: [] })) };
    });
    expect(await refreshFollowups(ctx)).toEqual({ refreshed: 3, kept: 2 });

    const rewrite = llm.calls.filter((c) => c.task === "write_email" && !c.input.prompt.includes("Sam")).at(-1)!;
    expect(rewrite.input.prompt).toContain('The first email (subject "scheduling at your company") is already written');
    expect(rewrite.input.prompt).toContain("I noticed your company is growing its team in Austin");
    expect(rewrite.input.prompt).not.toMatch(/^Step 1 \(day/m);

    const rows = await ctx.db.select().from(messages).orderBy(asc(messages.stepNumber));
    const of = (id: string, step: number) => rows.find((m) => m.threadId === id && m.stepNumber === step)!;
    expect(of(a.thread.id, 1).promptVersion).toBe("write_email@v0"); // the sent email is never touched
    for (const step of [2, 3, 4]) {
      expect(of(a.thread.id, step).promptVersion).toBe("write_email@v1");
      expect(of(a.thread.id, step).approvalState).toBe("auto_approved");
    }
    expect(of(a.thread.id, 2).body).toContain("Would a free preview of Northwind be useful");
    expect(of(a.thread.id, 2).body).not.toContain("https://");
    expect(of(a.thread.id, 2).body).toContain('Reply "stop"');
    expect(of(b.thread.id, 3).approvedBy).toBe("dashboard:dean");
    for (const step of [2, 3, 4]) expect(of(b.thread.id, step).promptVersion).toBe("write_email@v0");
    expect((of(b.thread.id, 2).qaVerdict as any).refreshedFor).toBe("write_email@v1");

    // Once per prompt version.
    const calls = llm.calls.length;
    expect(await refreshFollowups(ctx)).toEqual({ refreshed: 0, kept: 0 });
    expect(llm.calls.length).toBe(calls);
  });

  it("version B uses one of the set subject lines, the same one on every rewrite; version A keeps the writer's subject", async () => {
    const lines = ["jobber is going to hate this", "fire your software"];
    const cfg = testConfig((raw) => {
      raw.business.outreach.subject_lines_b = lines;
    });
    const a = await setup(cfg);
    const b = await anotherThread(a);
    await ctx.db.update(threads).set({ variant: "B" }).where(eq(threads.id, b.thread.id));
    llm.on("write_email", () => goodDraft(["f2"]));
    await writeThread(ctx, a.thread.id);
    await writeThread(ctx, b.thread.id);
    const rows = await ctx.db.select().from(messages).orderBy(asc(messages.stepNumber));
    const subj = (id: string, step: number) => rows.find((m) => m.threadId === id && m.stepNumber === step)!.subject;
    expect(subj(a.thread.id, 1)).toBe("scheduling at your company");
    expect(lines).toContain(subj(b.thread.id, 1));
    expect(subj(b.thread.id, 2)).toBe(`Re: ${subj(b.thread.id, 1)}`);
    const prompt = llm.calls.filter((c) => c.task === "write_email").at(-1)!.input.system;
    expect(prompt).toContain(`The step 1 subject is exactly "${subj(b.thread.id, 1)}"`);
  });

  it("a sequence that has sent nothing yet is rewritten whole under a new prompt, first email and subject included", async () => {
    const cfg = testConfig((raw) => {
      raw.engine.approval.force_all = false;
      raw.engine.approval.require_first_n = 0;
      raw.engine.approval.sample_rate = 0;
    });
    const a = await setup(cfg);
    llm.on("write_email", () => goodDraft(["f2"]));
    await writeThread(ctx, a.thread.id);
    await ctx.db.update(messages).set({ promptVersion: "write_email@v0" });

    llm.on("write_email", (input) => {
      const steps = [...input.prompt.matchAll(/^Step (\d) \(day/gm)].map((m) => Number(m[1]));
      return { subject: "Closing files", steps: steps.map((step) => ({ step, body: goodBody(step), fact_ids: [], proof_point_ids: [] })) };
    });
    expect(await refreshFollowups(ctx)).toEqual({ refreshed: 4, kept: 0 });
    const rewrite = llm.calls.filter((c) => c.task === "write_email").at(-1)!;
    expect(rewrite.input.prompt).toMatch(/^Step 1 \(day/m);
    expect(rewrite.input.prompt).not.toContain("is already written");
    const rows = await ctx.db.select().from(messages).orderBy(asc(messages.stepNumber));
    expect(rows.every((m) => m.promptVersion === "write_email@v1")).toBe(true);
    expect(rows.map((m) => m.subject)).toEqual(["Closing files", "Re: Closing files", "Re: Closing files", "Re: Closing files"]);
  });
});
