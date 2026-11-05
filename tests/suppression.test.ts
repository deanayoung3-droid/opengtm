/**
 * The suppress list, checked three ways: every way a person can be on it (address, +tag, company domain,
 * subdomain, company website when they use a personal address) blocks enrollment and sending; a domain added
 * mid-sequence stops live threads; and the leak check catches any send that slipped through.
 */
import { companies, contacts, isKillSwitchOn, isSuppressed, messages, MINUTE, suppress, suppressionLeaks, threads } from "@opengtm/core";
import { createTestCtx, FakeLlm, testConfig, type TestCtx } from "@opengtm/core/testing";
import { runHealthCheck } from "@opengtm/health";
import { ensureDefaultCampaigns, FakeTransport, runEnroll, runSchedule, runSendTick } from "@opengtm/sequencer";
import { runWrite } from "@opengtm/writer";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { goodDraft, passingCritic, seedCompany, seedMailbox } from "./fixtures";

async function world(companies: number) {
  const llm = new FakeLlm().on("critic", passingCritic).on("write_email", () => goodDraft(["f2"]));
  const config = testConfig((raw) => {
    raw.engine.approval.force_all = false;
    raw.engine.approval.require_first_n = 0;
    raw.engine.approval.sample_rate = 0;
  });
  const ctx = await createTestCtx({ llm, config, start: "2026-10-20T12:00:00Z" });
  await ensureDefaultCampaigns(ctx);
  await seedMailbox(ctx, { email: "jamie@outreach-mail.example", domain: "outreach-mail.example", provider: "google" });
  const transport = new FakeTransport(() => ctx.clock.now());
  const seeded = [];
  for (let i = 0; i < companies; i++) seeded.push(await seedCompany(ctx, { state: "CA", provider: "google" }));
  const deps = { transportFor: () => transport, publicBaseUrl: "https://gtm.example.com", unsubscribeSecret: "s" };
  return { ctx, transport, seeded, deps };
}

async function setEmail(ctx: TestCtx, companyId: string, email: string) {
  await ctx.db.update(contacts).set({ email }).where(eq(contacts.companyId, companyId));
}

/** Run the sender every 4 minutes for `days` (each mailbox waits 30s-5min between sends anyway). */
async function sendFor(w: Awaited<ReturnType<typeof world>>, days: number) {
  const end = w.ctx.clock.now().getTime() + days * 24 * 60 * MINUTE;
  while (w.ctx.clock.now().getTime() < end) {
    await runSendTick(w.ctx, w.deps);
    w.ctx.clock.advance(4 * MINUTE);
  }
}

describe("suppress list", () => {
  let ctx: TestCtx;
  afterEach(async () => ctx?.close());

  it("matches by address, +tag, domain, subdomain and the company's website", async () => {
    ctx = await createTestCtx({ start: "2026-10-20T12:00:00Z" });
    await suppress(ctx.db, { email: "jane@smithco.example" }, "unsubscribe", "test");
    await suppress(ctx.db, { domain: "jonesco.com" }, "existing customer", "test");

    expect(await isSuppressed(ctx.db, "JANE@SmithCo.example")).toBe(true);
    expect(await isSuppressed(ctx.db, "jane+intake@smithco.example")).toBe(true);
    expect(await isSuppressed(ctx.db, "bob@smithco.example")).toBe(false);
    expect(await isSuppressed(ctx.db, "ann@jonesco.com")).toBe(true);
    expect(await isSuppressed(ctx.db, "ann@mail.jonesco.com")).toBe(true);
    expect(await isSuppressed(ctx.db, "ann.jones@gmail.com", "jonesco.com")).toBe(true);
    expect(await isSuppressed(ctx.db, "ann.jones@gmail.com", "https://www.jonesco.com/")).toBe(true);
    expect(await isSuppressed(ctx.db, "ann.jones@gmail.com")).toBe(false);
    expect(await isSuppressed(ctx.db, "ann@notjonesco.com")).toBe(false);
  });

  it("refuses to block a whole public mail provider", async () => {
    ctx = await createTestCtx({ start: "2026-10-20T12:00:00Z" });
    await expect(suppress(ctx.db, { domain: "gmail.com" }, "oops", "test")).rejects.toThrow(/public mailbox provider/);
    await expect(suppress(ctx.db, { domain: "@Outlook.com" }, "oops", "test")).rejects.toThrow(/public mailbox provider/);
  });

  it("a company blocked mid-sequence stops its people, even on personal addresses", async () => {
    const w = await world(2);
    ctx = w.ctx;
    const [a, b] = w.seeded;
    await setEmail(ctx, a!.company.id, "ana.personal@gmail.com");
    await runEnroll(ctx, 50);
    await runWrite(ctx, 50);
    await runSchedule(ctx);
    expect(await ctx.db.select().from(threads)).toHaveLength(2);

    await suppress(ctx.db, { domain: a!.company.domain }, "asked by phone", "test");
    const stopped = await ctx.db.select().from(threads).where(eq(threads.companyId, a!.company.id));
    expect(stopped.every((t) => t.status === "stopped")).toBe(true);

    ctx.clock.set("2026-10-20T17:00:00Z");
    await sendFor(w, 1);
    expect(w.transport.sent.map((m) => m.email.to)).not.toContain("ana.personal@gmail.com");
    expect(w.transport.sent.some((m) => m.email.to.endsWith(b!.company.domain))).toBe(true);
  });

  it("triple check: 30 companies, 12 suppressed in every way, nobody suppressed is ever emailed", async () => {
    const w = await world(30);
    ctx = w.ctx;
    const companies = w.seeded.map((s) => s.company);
    // Some people use personal or subdomain addresses.
    await setEmail(ctx, companies[0]!.id, "owner0@gmail.com");
    await setEmail(ctx, companies[1]!.id, "owner1@yahoo.com");
    await setEmail(ctx, companies[2]!.id, `ana@mail.${companies[2]!.domain}`);

    const blocked = new Set<string>();
    const block = async (target: { email?: string; domain?: string }, companyId: string) => {
      await suppress(ctx.db, target, "test", "test");
      const [c] = await ctx.db.select().from(contacts).where(eq(contacts.companyId, companyId));
      blocked.add(c!.email);
    };
    // Before enrollment: company domain (personal address), company domain (subdomain address), exact address,
    // the plain form of a +tag address, plain company domains.
    await block({ domain: companies[0]!.domain }, companies[0]!.id);
    await block({ domain: companies[2]!.domain }, companies[2]!.id);
    await block({ email: `ana@${companies[3]!.domain}` }, companies[3]!.id);
    await setEmail(ctx, companies[4]!.id, `ana+law@${companies[4]!.domain}`);
    await block({ email: `ana@${companies[4]!.domain}` }, companies[4]!.id);
    for (const f of companies.slice(5, 8)) await block({ domain: f.domain }, f.id);

    await runEnroll(ctx, 100);
    await runWrite(ctx, 100);
    await runSchedule(ctx);
    const enrolled = await ctx.db.select({ email: contacts.email }).from(threads).innerJoin(contacts, eq(contacts.id, threads.contactId));
    expect(enrolled.filter((e) => blocked.has(e.email))).toEqual([]);
    expect(enrolled.length).toBe(23); // 30 companies minus the 7 blocked so far

    // After scheduling, before anything sends: personal address via company domain, address, domain.
    await block({ domain: companies[1]!.domain }, companies[1]!.id);
    await block({ email: `ana@${companies[8]!.domain}` }, companies[8]!.id);
    await block({ domain: companies[9]!.domain }, companies[9]!.id);

    ctx.clock.set("2026-10-20T17:00:00Z");
    await sendFor(w, 2);
    // Mid-sequence (after step 1 went out): later steps must not go.
    const sentOnce = [...new Set(w.transport.sent.map((m) => m.email.to))].filter((e) => !blocked.has(e)).slice(0, 2);
    expect(sentOnce).toHaveLength(2);
    for (const e of sentOnce) {
      const [c] = await ctx.db.select().from(contacts).where(eq(contacts.email, e));
      await block({ email: e }, c!.companyId);
    }
    const before = w.transport.sent.length;
    await sendFor(w, 6);

    const sentTo = w.transport.sent.map((m) => m.email.to);
    const preBlocked = [...blocked].filter((e) => !sentOnce.includes(e));
    expect(blocked.size).toBe(12);
    expect(sentTo.filter((e) => preBlocked.includes(e))).toEqual([]);
    expect(w.transport.sent.slice(before).filter((m) => sentOnce.includes(m.email.to))).toEqual([]);
    expect(new Set(sentTo).size).toBe(20); // everyone not blocked before sending was still emailed
    expect(await suppressionLeaks(ctx.db)).toEqual([]);
    const stillLive = await ctx.db
      .select({ email: contacts.email })
      .from(messages)
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .where(eq(messages.status, "scheduled"));
    expect(stillLive.filter((m) => blocked.has(m.email))).toEqual([]);
  }, 120_000);

  it("the leak check catches a send that slipped past and stops all sending", async () => {
    const w = await world(1);
    ctx = w.ctx;
    await runEnroll(ctx, 10);
    await runWrite(ctx, 10);
    await runSchedule(ctx);
    ctx.clock.set("2026-10-20T17:00:00Z");
    await runSendTick(ctx, w.deps);
    expect(w.transport.sent).toHaveLength(1);
    expect(await suppressionLeaks(ctx.db)).toEqual([]);

    // Simulate a bug: the address is suppressed, then a send is recorded anyway.
    await suppress(ctx.db, { email: w.transport.sent[0]!.email.to }, "unsubscribe", "test");
    ctx.clock.advance(10 * MINUTE);
    const [m] = await ctx.db.select().from(messages).where(eq(messages.status, "sent"));
    await ctx.db.update(messages).set({ sentAt: new Date(Date.now() + 60_000) }).where(eq(messages.id, m!.id));

    const leaks = await suppressionLeaks(ctx.db);
    expect(leaks.map((l) => l.to)).toEqual([w.transport.sent[0]!.email.to]);
    await runHealthCheck(ctx);
    expect(await isKillSwitchOn(ctx.db)).toBe(true);
    expect(ctx.sink.alerts.some((a) => a.title.startsWith("Email sent to a suppressed address"))).toBe(true);
  });
});
