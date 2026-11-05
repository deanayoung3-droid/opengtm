/**
 * Pilot rehearsal (build step 12): the whole pipeline end to end in approval
 * mode, over 16 simulated days, with unsubscribes, replies and bounces landing
 * mid-sequence. Invariants: zero sends to suppressed addresses, zero duplicate
 * sends, every fact claim traceable to a stored fact with a source URL.
 */
import { companies, contacts, facts, messages, MINUTE, isWithinWindow, suppress, threads, timezoneForState, teamDay } from "@opengtm/core";
import { createTestCtx, FakeLlm, type TestCtx } from "@opengtm/core/testing";
import { MockVendorSource, runDiscover, runQualify } from "@opengtm/leads";
import { htmlToText, runResearch, type FetchedPage, type PageFetcher } from "@opengtm/research";
import { ensureDefaultCampaigns, FakeReader, FakeTransport, runEnroll, runIngest, runSchedule, runSendTick, type InboundMessage } from "@opengtm/sequencer";
import { MockVerifier, runVerify, StaticMxResolver } from "@opengtm/verify";
import { bulkApprove, runWrite } from "@opengtm/writer";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { goodDraft, passingCritic, seedMailbox } from "./fixtures";

/** Every company site says the same two true things, so extracted facts are grounded. */
class CompanySiteFetcher implements PageFetcher {
  async fetch(url: string): Promise<FetchedPage | null> {
    const host = new URL(url).host;
    const html = `<html><head><title>${host}</title></head><body><h1>About</h1><p>Founded in 2012, the company focuses on hvac in its home county.</p><p>We are hiring a dispatcher to join our team.</p></body></html>`;
    return { url, status: 200, html, ...htmlToText(html), fetchedAt: new Date() };
  }
}

function inbound(p: Partial<InboundMessage>): InboundMessage {
  return { uid: String(Math.random()), rfcMessageId: `<p${Math.random()}@x>`, inReplyTo: null, references: [], from: "", to: [], subject: "", text: "", date: new Date(), headers: {}, contentType: "text/plain", attachmentsText: [], ...p };
}

describe("pilot rehearsal (acceptance)", () => {
  let ctx: TestCtx;
  afterEach(async () => ctx?.close());

  it("zero sends to suppressed addresses, zero duplicates, all claims traceable", async () => {
    const llm = new FakeLlm()
      .on("critic", passingCritic)
      .on("write_email", () => goodDraft(["f1"]))
      .on("research_extract", (input) => {
        const url = input.prompt.match(/<page url="([^"]+)">/)![1]!;
        return { facts: [{ text: "Founded in 2012, the company focuses on hvac in its home county", source_url: url, kind: "about" }], focus_areas: ["hvac"], team_size: null };
      });
    ctx = await createTestCtx({ llm, start: "2026-10-19T13:00:00Z" }); // Monday; approval mode is on by default
    await ensureDefaultCampaigns(ctx);
    const google = await seedMailbox(ctx, { email: "a@outreach-mail.example", domain: "outreach-mail.example", provider: "google" });
    const microsoft = await seedMailbox(ctx, { email: "b@outreach-mail-two.example", domain: "outreach-mail-two.example", provider: "microsoft" });
    const transports = new Map([
      [google.id, new FakeTransport(() => ctx.clock.now())],
      [microsoft.id, new FakeTransport(() => ctx.clock.now())],
    ]);
    const deps = { transportFor: (mb: { id: string }) => transports.get(mb.id)!, publicBaseUrl: "https://gtm.example.com", unsubscribeSecret: "s" };
    const reader = new FakeReader();

    // Discover -> qualify -> verify -> research -> enroll -> write
    await runDiscover(ctx, [new MockVendorSource(40)], { segmentId: "hvac", limitPerSegment: 40 });
    await runQualify(ctx);
    await runVerify(ctx, { verifier: new MockVerifier(), mx: new StaticMxResolver({}, ["aspmx.l.google.com"]) }, 500);
    await runResearch(ctx, new CompanySiteFetcher(), 100);
    await runEnroll(ctx, 200);
    await runWrite(ctx, 200);

    // Human reviews every draft (approval mode), then the pilot starts.
    const drafts = await ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.approvalState, "pending"));
    expect(drafts.length).toBeGreaterThan(0);
    const approved = await bulkApprove(ctx, drafts.map((d) => d.id), "pilot-reviewer");
    expect(approved.failed).toEqual([]);
    await runSchedule(ctx);

    const threadRows = await ctx.db.select().from(threads);
    const people = await ctx.db.select().from(contacts).where(inArray(contacts.id, threadRows.map((t) => t.contactId)));
    // One contact per company.
    expect(new Set(threadRows.map((t) => t.companyId)).size).toBe(threadRows.length);

    const suppressedAt = new Map<string, number>(); // email -> sim time
    const end = new Date("2026-11-04T00:00:00Z").getTime();
    let tick = 0;
    let injected = false;
    while (ctx.clock.now().getTime() < end) {
      // Day 2: three people unsubscribe through the link; one replies; one hard-bounces.
      if (!injected && ctx.clock.now() >= new Date("2026-10-21T18:00:00Z")) {
        injected = true;
        for (const p of people.slice(0, 3)) {
          await suppress(ctx.db, { email: p.email }, "unsubscribe", "pilot-test");
          suppressedAt.set(p.email, ctx.clock.now().getTime());
        }
        const sent = await ctx.db.select().from(messages).where(eq(messages.status, "sent"));
        const byContact = new Map(sent.map((m) => [m.contactId, m]));
        const replier = people.find((p) => !suppressedAt.has(p.email) && byContact.has(p.id))!;
        const bouncer = people.find((p) => !suppressedAt.has(p.email) && p.id !== replier.id && byContact.has(p.id))!;
        reader.queue.push(inbound({ from: replier.email, inReplyTo: byContact.get(replier.id)!.rfcMessageId, subject: "Re: x", text: "Interested, send times." }));
        reader.queue.push(
          inbound({
            from: "mailer-daemon@googlemail.com",
            subject: "Delivery Status Notification (Failure)",
            contentType: "multipart/report; report-type=delivery-status",
            attachmentsText: [`Final-Recipient: rfc822; ${bouncer.email}\nStatus: 5.1.1`, `Message-ID: ${byContact.get(bouncer.id)!.rfcMessageId}`],
          }),
        );
        await runIngest(ctx, () => reader);
        suppressedAt.set(bouncer.email, ctx.clock.now().getTime());
        suppressedAt.set(`replied:${replier.email}`, ctx.clock.now().getTime());
      }
      await runSendTick(ctx, deps);
      if (++tick % 6 === 0) await runSchedule(ctx);
      ctx.clock.advance(10 * MINUTE);
    }

    const allSends = [...transports.values()].flatMap((t) => t.sent);
    expect(allSends.length).toBeGreaterThan(threadRows.length); // step 1s plus follow-ups

    // 1) Zero sends to suppressed (or replied) addresses after the event.
    for (const s of allSends) {
      for (const key of [s.email.to, `replied:${s.email.to}`]) {
        const at = suppressedAt.get(key);
        if (at !== undefined) expect(s.at.getTime(), `sent to ${s.email.to} after suppression`).toBeLessThan(at);
      }
    }

    // 2) Zero duplicates: each thread step goes out at most once, ids unique.
    const sentRows = await ctx.db.select().from(messages).where(eq(messages.status, "sent"));
    expect(sentRows).toHaveLength(allSends.length);
    expect(new Set(sentRows.map((m) => `${m.threadId}:${m.stepNumber}`)).size).toBe(sentRows.length);
    expect(new Set(allSends.map((s) => s.email.messageId)).size).toBe(allSends.length);

    // 3) Every fact claim traces to a stored fact of that company with a source URL; proof points exist in config.
    const tById = new Map(threadRows.map((t) => [t.id, t]));
    const pp = new Set(ctx.config.proofPoints.map((p) => p.id));
    for (const m of sentRows) {
      for (const fid of m.factIds) {
        const [f] = await ctx.db.select().from(facts).where(and(eq(facts.id, fid), eq(facts.companyId, tById.get(m.threadId)!.companyId)));
        expect(f, `fact ${fid} missing for message ${m.id}`).toBeDefined();
        expect(f!.sourceUrl).toMatch(/^https:\/\//);
      }
      for (const id of m.proofPointIds) expect(pp.has(id)).toBe(true);
      expect(m.approvedBy).toBe("pilot-reviewer"); // nothing went out unreviewed
      expect(m.body).toContain(ctx.config.business.company.physical_address);
    }
    expect(sentRows.some((m) => m.factIds.length > 0)).toBe(true);

    // 4) Caps and windows held throughout.
    const perMbDay = new Map<string, number>();
    const companyState = new Map((await ctx.db.select().from(companies)).map((c) => [c.id, c.state]));
    for (const m of sentRows) {
      const k = `${m.mailboxId}:${teamDay(m.sentAt!)}`;
      perMbDay.set(k, (perMbDay.get(k) ?? 0) + 1);
      expect(isWithinWindow(m.sentAt!, timezoneForState(companyState.get(tById.get(m.threadId)!.companyId)), ctx.config.engine.timing)).toBe(true);
    }
    expect(Math.max(...perMbDay.values())).toBeLessThanOrEqual(25); // week 1-2 ramp
  }, 300_000);
});
