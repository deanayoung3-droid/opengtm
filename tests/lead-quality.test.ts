import { contacts, messages, replies, threads, type ReplyLabel } from "@opengtm/core";
import { createTestCtx, type TestCtx } from "@opengtm/core/testing";
import { replySources } from "@opengtm/learning";
import { type AiArkSource } from "@opengtm/leads";
import { leadStock, runEnroll } from "@opengtm/sequencer";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../apps/worker/src/context";
import { leadSources } from "../apps/worker/src/jobs";
import { seedCompany, seedMailbox, seedSequence } from "./fixtures";

describe("lead quality and pacing", () => {
  let ctx: TestCtx;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined as unknown as TestCtx;
  });

  const runtime = (c: TestCtx) => ({ ctx: c, dryRun: false, fetcher: {} }) as unknown as Runtime;
  const runBudget = async (c: TestCtx) => {
    const [src] = (await leadSources(runtime(c))) as AiArkSource[];
    return (src as unknown as { opts: { maxCreditsPerRun: number } }).opts.maxCreditsPerRun;
  };

  it("AI Ark buys only what the mailboxes can email in the next days, minus companies already waiting", async () => {
    ctx = await createTestCtx({ start: "2026-10-20T15:00:00Z" });
    ctx.env = { AI_ARK_API_KEY: "k", AI_ARK_TERMS_OK: "1" };
    Object.assign(ctx.config.engine.leads.ai_ark, { stock_days: 3, credits_per_person: 1.1, max_credits_per_run: 150 });
    await seedSequence(ctx);

    // No active mailbox: nothing can be emailed, so nothing is bought.
    expect(await leadStock(ctx)).toEqual({ perDay: 0, waiting: 0 });
    expect(await runBudget(ctx)).toBe(0);

    // One mailbox in its first week: 15 emails a day, 4 steps each (test sequence) = 3 new people a day.
    await seedMailbox(ctx);
    expect(await leadStock(ctx)).toEqual({ perDay: 3, waiting: 0 });
    expect(await runBudget(ctx)).toBe(10); // 3 days x 3 people x 1.1 credits

    // Companies already waiting for a first email (free new-company leads included) are used before buying more.
    for (let i = 0; i < 4; i++) await seedCompany(ctx);
    expect((await leadStock(ctx)).waiting).toBe(4);
    expect(await runBudget(ctx)).toBe(6); // 5 short
    for (let i = 0; i < 6; i++) await seedCompany(ctx);
    expect(await runBudget(ctx)).toBe(0);
  });

  it("emails the person who decides first: owners at a named address before managers and info@", async () => {
    ctx = await createTestCtx({ start: "2026-10-20T15:00:00Z" });
    await seedSequence(ctx);
    await seedMailbox(ctx);
    const company = async (role: string | null, email?: string) => {
      const f = await seedCompany(ctx);
      await ctx.db.update(contacts).set({ role, ...(email ? { email: `${email}@${f.company.domain}`, isRoleAddress: true } : {}) }).where(eq(contacts.id, f.contact.id));
      return f.contact.id;
    };
    const office = await company("office manager");
    const info = await company(null, "info");
    const owner = await company("owner");
    const partner = await company("general manager");

    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      await runEnroll(ctx, 1);
      const rows = await ctx.db.select({ c: threads.contactId }).from(threads);
      order.push(rows.map((r) => r.c).find((c) => !order.includes(c))!);
    }
    expect(order).toEqual([owner, partner, office, info]);
  });

  it("reports real replies, auto-replies and bounces per lead source and kind of person", async () => {
    ctx = await createTestCtx({ start: "2026-10-20T15:00:00Z" });
    const { campaign } = await seedSequence(ctx);
    const mb = await seedMailbox(ctx);
    const emailed = async (source: string, role: string | null, labels: ReplyLabel[] = [], roleAddress = false) => {
      const f = await seedCompany(ctx);
      await ctx.db.update(contacts).set({ source, role, isRoleAddress: roleAddress }).where(eq(contacts.id, f.contact.id));
      const [t] = await ctx.db.insert(threads).values({ contactId: f.contact.id, companyId: f.company.id, campaignId: campaign.id, mailboxId: mb.id, status: "active" }).returning();
      for (const step of [1, 2]) {
        await ctx.db.insert(messages).values({ threadId: t!.id, contactId: f.contact.id, stepNumber: step, subject: "s", body: "b", status: "sent", sentAt: ctx.clock.now() });
      }
      for (const label of labels) {
        await ctx.db.insert(replies).values({ threadId: t!.id, contactId: f.contact.id, mailboxId: mb.id, fromEmail: f.contact.email, receivedAt: ctx.clock.now(), label, rfcMessageId: `<${Math.random()}@x>` });
      }
    };
    await emailed("ai_ark", "owner", ["interested"]);
    await emailed("ai_ark", "owner", ["out_of_office", "objection"]); // away first, then wrote back: real
    await emailed("ai_ark", "owner");
    await emailed("ai_ark", "owner", ["bounce"]);
    await emailed("new_filing", null, ["out_of_office"], true);
    await emailed("new_filing", null, ["other"], true); // unclear: neither real nor automatic

    const rows = await replySources(ctx);
    expect(rows).toEqual([
      { source: "ai_ark", who: "owner", emailed: 4, real: 2, positive: 1, auto: 1, bounced: 1 },
      { source: "new_filing", who: "role_address", emailed: 2, real: 0, positive: 0, auto: 1, bounced: 0 },
    ]);
  });
});
