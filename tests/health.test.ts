import { domains, events, mailboxes, MINUTE, recordEvent, resumeMailbox, seedTests } from "@opengtm/core";
import { createTestCtx, testConfig, type TestCtx } from "@opengtm/core/testing";
import { FakeSeedChecker, runHealthCheck, runSeedCheck, runSeedSend } from "@opengtm/health";
import { FakeTransport } from "@opengtm/sequencer";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { seedMailbox } from "./fixtures";

async function inject(ctx: TestCtx, mailboxId: string, sent: number, bounces: number, complaints = 0) {
  for (let i = 0; i < sent; i++) await recordEvent(ctx.db, "sent", { mailboxId, at: ctx.clock.now() });
  for (let i = 0; i < bounces; i++) await recordEvent(ctx.db, "bounced_hard", { mailboxId, at: ctx.clock.now() });
  for (let i = 0; i < complaints; i++) await recordEvent(ctx.db, "complaint", { mailboxId, at: ctx.clock.now() });
}

describe("health module", () => {
  let ctx: TestCtx;
  afterEach(async () => ctx?.close());

  it("an injected 5% bounce rate pauses the mailbox and alerts (acceptance)", async () => {
    ctx = await createTestCtx();
    const mb = await seedMailbox(ctx);
    await inject(ctx, mb.id, 60, 3); // 5%
    const report = await runHealthCheck(ctx);
    expect(report[0]!.bounceRate).toBeCloseTo(0.05);
    const [after] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(after!.status).toBe("paused");
    expect(after!.pausedReason).toContain("5.0%");
    expect(ctx.sink.alerts.find((a) => a.key === `mailbox_paused:${mb.id}`)?.level).toBe("critical");
    expect((await ctx.db.select().from(events).where(eq(events.type, "paused"))).length).toBe(1);
  });

  it("stays active under the threshold or below the minimum sample", async () => {
    ctx = await createTestCtx();
    const a = await seedMailbox(ctx, { email: "a@outreach-mail.example" });
    const b = await seedMailbox(ctx, { email: "b@outreach-mail.example" });
    await inject(ctx, a.id, 100, 1); // 1%
    await inject(ctx, b.id, 10, 1); // 10% but only 10 sends
    await runHealthCheck(ctx);
    const rows = await ctx.db.select().from(mailboxes);
    expect(rows.every((r) => r.status === "active")).toBe(true);
    expect(rows.find((r) => r.id === a.id)!.healthScore).toBe(85);
  });

  it("two bounces never pause a mailbox by themselves, even at 4% of its first 49 sends (as happened in practice); three do", async () => {
    ctx = await createTestCtx();
    const mb = await seedMailbox(ctx);
    await inject(ctx, mb.id, 49, 2);
    await runHealthCheck(ctx);
    expect((await ctx.db.select().from(mailboxes))[0]!.status).toBe("active");
    await inject(ctx, mb.id, 0, 1);
    await runHealthCheck(ctx);
    const [after] = await ctx.db.select().from(mailboxes);
    expect(after!.status).toBe("paused");
    expect(after!.pausedReason).toContain("3 bounces");
  });

  it("a bounce from the recipient's own server (a mail loop, a full mailbox) doesn't count against the mailbox", async () => {
    ctx = await createTestCtx();
    const mb = await seedMailbox(ctx);
    await inject(ctx, mb.id, 40, 2);
    await recordEvent(ctx.db, "bounced_hard", { mailboxId: mb.id, data: { status: "5.4.14" }, at: ctx.clock.now() });
    await recordEvent(ctx.db, "bounced_hard", { mailboxId: mb.id, data: { status: "5.2.2" }, at: ctx.clock.now() });
    const report = await runHealthCheck(ctx);
    expect(report[0]!.hardBounces).toBe(2);
    expect((await ctx.db.select().from(mailboxes))[0]!.status).toBe("active");
    await recordEvent(ctx.db, "bounced_hard", { mailboxId: mb.id, data: { status: "5.1.1" }, at: ctx.clock.now() });
    await runHealthCheck(ctx);
    expect((await ctx.db.select().from(mailboxes))[0]!.status).toBe("paused");
  });

  it("a mailbox paused for bounces resumes by itself once the numbers allow; a person's pause stays", async () => {
    ctx = await createTestCtx();
    const a = await seedMailbox(ctx, { email: "a@outreach-mail.example" });
    const b = await seedMailbox(ctx, { email: "b@outreach-mail.example" });
    await inject(ctx, a.id, 20, 1);
    await ctx.db.update(mailboxes).set({ status: "paused", pausedReason: "hard bounce rate 5.0% over 20 sends (limit 2.0%)" }).where(eq(mailboxes.id, a.id));
    await ctx.db.update(mailboxes).set({ status: "paused", pausedReason: "paused by dean" }).where(eq(mailboxes.id, b.id));
    await runHealthCheck(ctx);
    const rows = await ctx.db.select().from(mailboxes);
    expect(rows.find((r) => r.id === a.id)!.status).toBe("active");
    expect(rows.find((r) => r.id === b.id)!.status).toBe("paused");
    expect(ctx.sink.alerts.some((x) => x.title === "Mailbox sending again: a@outreach-mail.example")).toBe(true);
  });

  it("a person's Resume sticks: bounces before it no longer count, and new ones still pause the mailbox", async () => {
    ctx = await createTestCtx();
    const mb = await seedMailbox(ctx);
    await inject(ctx, mb.id, 58, 3); // 5.2%
    await runHealthCheck(ctx);
    expect((await ctx.db.select().from(mailboxes))[0]!.status).toBe("paused");
    ctx.clock.advance(MINUTE);
    await resumeMailbox(ctx, mb.id, "sam@company.example");
    ctx.clock.advance(15 * MINUTE);
    await runHealthCheck(ctx);
    expect((await ctx.db.select().from(mailboxes))[0]!.status).toBe("active");
    await inject(ctx, mb.id, 30, 3); // 3 new bounces over 30 sends since the resume
    await runHealthCheck(ctx);
    const [after] = await ctx.db.select().from(mailboxes);
    expect(after!.status).toBe("paused");
    expect(after!.pausedReason).toContain("over 30 sends");
  });

  it("a spam complaint above 0.1% pauses the sending domain", async () => {
    ctx = await createTestCtx();
    const mb = await seedMailbox(ctx);
    await inject(ctx, mb.id, 200, 0, 1);
    await runHealthCheck(ctx);
    const [d] = await ctx.db.select().from(domains);
    expect(d!.status).toBe("paused");
    expect(ctx.sink.alerts.some((a) => a.title.startsWith("Sending domain paused"))).toBe(true);
  });

  it("seed tests below 85% placement retire the mailbox and its domain", async () => {
    const config = testConfig((raw) => {
      raw.engine.health.seed_inboxes = [
        { address: "seed1@gmail.example", provider: "google", imap_env: "SEED1" },
        { address: "seed2@outlook.example", provider: "microsoft", imap_env: "SEED2" },
      ];
    });
    ctx = await createTestCtx({ config });
    const good = await seedMailbox(ctx, { email: "good@clean.example", domain: "clean.example" });
    const bad = await seedMailbox(ctx, { email: "bad@burned.example", domain: "burned.example" });
    const transport = new FakeTransport(() => ctx.clock.now());
    expect(await runSeedSend(ctx, () => transport)).toBe(4);
    expect(transport.sent.every((s) => /ref-[0-9a-f]{12}/.test(s.email.text))).toBe(true);

    const tokensFor = async (id: string) => new Set((await ctx.db.select().from(seedTests).where(eq(seedTests.mailboxId, id))).map((s) => s.token));
    const badTokens = await tokensFor(bad.id);
    ctx.clock.advance(15 * MINUTE);
    const res = await runSeedCheck(ctx, new FakeSeedChecker((_, token) => (badTokens.has(token) ? "spam" : "inbox")));
    expect(res.checked).toBe(4);
    expect(res.retired).toEqual(["bad@burned.example"]);
    const mbs = await ctx.db.select().from(mailboxes);
    expect(mbs.find((m) => m.id === good.id)!.status).toBe("active");
    expect(mbs.find((m) => m.id === bad.id)!.status).toBe("retired");
    const doms = await ctx.db.select().from(domains);
    expect(doms.find((d) => d.name === "burned.example")!.status).toBe("retired");
    expect(doms.find((d) => d.name === "clean.example")!.status).toBe("active");
    // Not due again for a week.
    expect(await runSeedSend(ctx, () => transport)).toBe(0);
  });

  it("warns at 80% of the daily spend cap", async () => {
    ctx = await createTestCtx();
    const { recordSpend } = await import("@opengtm/core");
    await recordSpend(ctx.db, "llm", ctx.config.engine.caps.daily_spend_cap_usd * 0.85, { at: ctx.clock.now() });
    await runHealthCheck(ctx);
    expect(ctx.sink.alerts.some((a) => a.key === "spend_cap_80")).toBe(true);
  });
});
