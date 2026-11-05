import { runHealthCheck } from "@opengtm/health";
import {
  contacts,
  events,
  isWithinWindow,
  mailboxes,
  messages,
  MINUTE,
  replies,
  setKillSwitch,
  suppress,
  suppression,
  threads,
  timezoneForState,
  companies,
  teamDay,
} from "@opengtm/core";
import { createTestCtx, FakeLlm, testConfig, type TestCtx } from "@opengtm/core/testing";
import {
  ensureDefaultCampaigns,
  FakeReader,
  FakeTransport,
  runEnroll,
  runIngest,
  runSchedule,
  runSendTick,
  SendError,
  type InboundMessage,
} from "@opengtm/sequencer";
import { runWrite } from "@opengtm/writer";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { goodDraft, passingCritic, seedCompany, seedMailbox } from "./fixtures";

const STATES = ["CA", "NY", "TX", "FL", "IL"];

function autoApproveConfig() {
  return testConfig((raw) => {
    raw.engine.approval.force_all = false;
    raw.engine.approval.require_first_n = 0;
    raw.engine.approval.sample_rate = 0;
  });
}

async function world(n: number) {
  const llm = new FakeLlm().on("critic", passingCritic).on("write_email", () => goodDraft(["f2"]));
  const ctx = await createTestCtx({ llm, config: autoApproveConfig(), start: "2026-10-20T12:00:00Z" });
  await ensureDefaultCampaigns(ctx);
  const google = await seedMailbox(ctx, { email: "jamie@outreach-mail.example", domain: "outreach-mail.example", provider: "google" });
  const microsoft = await seedMailbox(ctx, { email: "jamie@outreach-mail-two.example", domain: "outreach-mail-two.example", provider: "microsoft" });
  const transports = new Map([
    [google.id, new FakeTransport(() => ctx.clock.now())],
    [microsoft.id, new FakeTransport(() => ctx.clock.now())],
  ]);
  for (let i = 0; i < n; i++) {
    await seedCompany(ctx, { state: STATES[i % STATES.length], provider: (["google", "microsoft", "other"] as const)[i % 3] });
  }
  const deps = {
    transportFor: (mb: { id: string }) => transports.get(mb.id)!,
    publicBaseUrl: "https://gtm.example.com",
    unsubscribeSecret: "test-secret",
  };
  return { ctx, llm, google, microsoft, transports, deps };
}

async function prime(ctx: TestCtx) {
  await runEnroll(ctx, 500);
  await runWrite(ctx, 500);
  await runSchedule(ctx);
}

describe("sequencer: 3+ day simulation with a fake transport (acceptance)", () => {
  let ctx: TestCtx;
  afterEach(async () => ctx?.close());

  it("honors caps, business windows, jitter, matching, and threading headers", async () => {
    const w = await world(60);
    ctx = w.ctx;
    await prime(ctx);
    const threadRows = await ctx.db.select().from(threads);
    expect(threadRows).toHaveLength(60);

    // Simulate Tue 12:00Z through Sat, ticking every 3 minutes.
    const end = new Date("2026-10-24T12:00:00Z").getTime();
    let tick = 0;
    while (ctx.clock.now().getTime() < end) {
      await runSendTick(ctx, w.deps);
      if (++tick % 10 === 0) await runSchedule(ctx);
      ctx.clock.advance(3 * MINUTE);
    }

    const sent = await ctx.db
      .select({ m: messages, state: companies.state, mailboxId: threads.mailboxId, provider: contacts.mailProvider })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(companies, eq(companies.id, threads.companyId))
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .where(eq(messages.status, "sent"));
    expect(sent.length).toBeGreaterThan(60); // all step 1s plus some step 2s

    // Caps: <= 15/day per mailbox in week 1, <= global cap per day.
    const perMbDay = new Map<string, number>();
    const perDay = new Map<string, number>();
    for (const { m } of sent) {
      const k = `${m.mailboxId}:${teamDay(m.sentAt!)}`;
      perMbDay.set(k, (perMbDay.get(k) ?? 0) + 1);
      perDay.set(teamDay(m.sentAt!), (perDay.get(teamDay(m.sentAt!)) ?? 0) + 1);
    }
    expect(Math.max(...perMbDay.values())).toBeLessThanOrEqual(15);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(ctx.config.engine.caps.daily_send_cap);

    // Windows: every send inside the recipient's local business hours on a weekday.
    for (const { m, state } of sent) {
      expect(isWithinWindow(m.sentAt!, timezoneForState(state), ctx.config.engine.timing)).toBe(true);
    }

    // Provider matching: Google and Microsoft recipients go out from the same provider.
    const mbProvider = new Map([[w.google.id, "google"], [w.microsoft.id, "microsoft"]]);
    for (const { mailboxId, provider } of sent) {
      if (provider === "google" || provider === "microsoft") expect(mbProvider.get(mailboxId!)).toBe(provider);
    }

    // Exactly-once: fake transports, DB, and events agree; message ids unique.
    const fakeSent = [...w.transports.values()].flatMap((t) => t.sent);
    expect(fakeSent).toHaveLength(sent.length);
    const evs = await ctx.db.select().from(events).where(eq(events.type, "sent"));
    expect(evs).toHaveLength(sent.length);
    expect(new Set(fakeSent.map((s) => s.email.messageId)).size).toBe(fakeSent.length);

    // Jitter: >= 30s between sends on the same mailbox.
    for (const t of w.transports.values()) {
      const times = t.sent.map((s) => s.at.getTime()).sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(30_000);
    }

    // Threading: follow-ups reply to the prior message, reference the chain, keep the subject.
    const byThread = new Map<string, (typeof messages.$inferSelect)[]>();
    for (const { m } of sent) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
    let followUps = 0;
    for (const ms of byThread.values()) {
      ms.sort((a, b) => a.stepNumber - b.stepNumber);
      expect(ms[0]!.stepNumber).toBe(1);
      expect(ms[0]!.inReplyTo).toBeNull();
      for (let i = 1; i < ms.length; i++) {
        followUps++;
        expect(ms[i]!.inReplyTo).toBe(ms[i - 1]!.rfcMessageId);
        expect(ms[i]!.references).toContain(ms[0]!.rfcMessageId!);
        expect(ms[i]!.subject).toBe(`Re: ${ms[0]!.subject}`);
        expect(ms[i]!.sentAt!.getTime() - ms[0]!.sentAt!.getTime()).toBeGreaterThanOrEqual(3 * 24 * 60 * MINUTE);
      }
    }
    expect(followUps).toBeGreaterThan(0);

    // Hygiene: a plain-text part, unsubscribe headers, footer, accurate From/Reply-To.
    const sample = fakeSent.find((s) => s.email.inReplyTo)!;
    const mime = sample.mime.replace(/\r\n[ \t]+/g, " "); // unfold RFC 5322 folded headers
    expect(mime).toMatch(/^Content-Type: text\/plain/m);
    // The HTML part only adds the signature (no logo is configured here): no remote images, no web links.
    expect(mime).not.toMatch(/Content-Id:/i);
    expect(mime).not.toMatch(/src=3D"http|src="http|href=3D"http|href="http/i);
    expect(mime).toMatch(/^List-Unsubscribe: <https:\/\/gtm\.example\.com\/u\/[^>]+>, <mailto:/m);
    expect(mime).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
    expect(mime).toMatch(/^In-Reply-To: </m);
    expect(mime).toMatch(/^References: </m);
    expect(sample.email.replyTo).toBe(sample.email.from.address);
  }, 300_000);

  it("kill switch stops all sending", async () => {
    const w = await world(4);
    ctx = w.ctx;
    await prime(ctx);
    ctx.clock.set("2026-10-20T16:00:00Z");
    await setKillSwitch(ctx.db, true, "test");
    const r = await runSendTick(ctx, w.deps);
    expect(r.skipped).toBe("kill_switch");
    expect([...w.transports.values()].every((t) => t.sent.length === 0)).toBe(true);
  });

  it("never re-sends after a crash mid-send; marks unknown and alerts", async () => {
    const w = await world(1);
    ctx = w.ctx;
    await prime(ctx);
    const [m] = await ctx.db.select().from(messages).where(eq(messages.status, "scheduled"));
    await ctx.db.update(messages).set({ status: "sending", claimedAt: ctx.clock.now() }).where(eq(messages.id, m!.id));
    ctx.clock.set("2026-10-20T17:00:00Z");
    await runSendTick(ctx, w.deps);
    const [after] = await ctx.db.select().from(messages).where(eq(messages.id, m!.id));
    expect(after!.status).toBe("unknown");
    expect(ctx.sink.alerts.some((a) => a.title === "Send outcome unknown")).toBe(true);
    expect([...w.transports.values()].every((t) => t.sent.length === 0)).toBe(true);
  });

  it("auth failure trips the mailbox circuit breaker; message stays queued", async () => {
    const w = await world(3);
    ctx = w.ctx;
    await prime(ctx);
    ctx.clock.set("2026-10-20T17:00:00Z");
    for (const t of w.transports.values()) t.failures.push(new SendError("535 auth failed", "auth", 535));
    await runSendTick(ctx, w.deps);
    const mbs = await ctx.db.select().from(mailboxes);
    expect(mbs.filter((m) => m.status === "paused").length).toBeGreaterThan(0);
    expect(ctx.sink.alerts.some((a) => a.title.startsWith("Mailbox paused"))).toBe(true);
    expect((await ctx.db.select().from(messages).where(eq(messages.status, "failed"))).length).toBe(0);
  });

  it("SMTP recipient rejection counts as a hard bounce and suppresses", async () => {
    const w = await world(1);
    ctx = w.ctx;
    await prime(ctx);
    ctx.clock.set("2026-10-20T17:00:00Z");
    for (const t of w.transports.values()) t.failures.push(new SendError("550 5.1.1 user unknown", "recipient", 550));
    await runSendTick(ctx, w.deps);
    expect(await ctx.db.select().from(suppression)).toHaveLength(1);
    const [t] = await ctx.db.select().from(threads);
    expect(t!.status).toBe("stopped");
  });

  it("does not send to an address suppressed after scheduling", async () => {
    const w = await world(1);
    ctx = w.ctx;
    await prime(ctx);
    const [c] = await ctx.db.select().from(contacts);
    await suppress(ctx.db, { email: c!.email }, "unsubscribe", "test");
    ctx.clock.set("2026-10-20T17:00:00Z");
    await runSendTick(ctx, w.deps);
    expect([...w.transports.values()].every((t) => t.sent.length === 0)).toBe(true);
  });

  it("refuses to send while compliance config is incomplete", async () => {
    const w = await world(1);
    ctx = w.ctx;
    await prime(ctx);
    ctx.config = testConfig((raw) => (raw.business.company.physical_address = ""));
    ctx.clock.set("2026-10-20T17:00:00Z");
    expect((await runSendTick(ctx, w.deps)).skipped).toBe("config_incomplete");
  });

  describe("reply and bounce ingest", () => {
    function inbound(p: Partial<InboundMessage>): InboundMessage {
      return { uid: String(Math.random()), rfcMessageId: `<r${Math.random()}@x>`, inReplyTo: null, references: [], from: "", to: [], subject: "", text: "", date: new Date("2026-10-21T15:00:00Z"), headers: {}, contentType: "text/plain", attachmentsText: [], ...p };
    }

    async function sentOne() {
      const w = await world(2);
      ctx = w.ctx;
      await prime(ctx);
      ctx.clock.set("2026-10-20T17:00:00Z");
      await runSendTick(ctx, w.deps);
      const [m] = await ctx.db.select().from(messages).where(eq(messages.status, "sent")).orderBy(asc(messages.sentAt));
      const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, m!.contactId));
      const reader = new FakeReader();
      return { w, m: m!, c: c!, reader };
    }

    it("a human reply stops the sequence and is stored for classification", async () => {
      const { m, c, reader } = await sentOne();
      reader.queue.push(inbound({ from: c.email, inReplyTo: m.rfcMessageId, subject: `Re: ${m.subject}`, text: "Sure, send me times.\n\nOn Tue, Jamie wrote:\n> Hi Ana" }));
      const stats = await runIngest(ctx, () => reader);
      expect(stats.replies).toBe(1);
      const [r] = await ctx.db.select().from(replies);
      expect(r!.body).toBe("Sure, send me times.");
      const [t] = await ctx.db.select().from(threads).where(eq(threads.id, m.threadId));
      expect(t!.status).toBe("stopped");
      const pending = await ctx.db.select().from(messages).where(and(eq(messages.threadId, m.threadId), eq(messages.status, "scheduled")));
      expect(pending).toHaveLength(0);
      // Re-ingesting the same message is a no-op.
      reader.queue.push(inbound({ rfcMessageId: r!.rfcMessageId, from: c.email, inReplyTo: m.rfcMessageId }));
      expect((await runIngest(ctx, () => reader)).replies).toBe(0);
    });

    it("matches a reply from a colleague at the same company when the headers are missing", async () => {
      const { m, c, reader } = await sentOne();
      const domain = c.email.split("@")[1]!;
      reader.queue.push(inbound({ from: `assistant@${domain}`, subject: `Re: ${m.subject}`, text: "Ana asked me to say yes, please send it." }));
      reader.queue.push(inbound({ from: "stranger@gmail.com", subject: "hello", text: "Who is this?" }));
      const stats = await runIngest(ctx, () => reader);
      expect(stats).toMatchObject({ replies: 1, unmatched: 1 });
      const [r] = await ctx.db.select().from(replies);
      expect(r!.threadId).toBe(m.threadId);
      expect(r!.fromEmail).toBe(`assistant@${domain}`);
    });

    it("an out-of-office auto-reply does not stop the sequence", async () => {
      const { m, c, reader } = await sentOne();
      reader.queue.push(inbound({ from: c.email, inReplyTo: m.rfcMessageId, subject: "Automatic reply: billing", headers: { "auto-submitted": "auto-replied" }, text: "I am out of the office until November 2." }));
      await runIngest(ctx, () => reader);
      const [t] = await ctx.db.select().from(threads).where(eq(threads.id, m.threadId));
      expect(t!.status).toBe("active");
    });

    it("a DSN hard bounce suppresses the address and is attributed to the sending mailbox", async () => {
      const { m, c, reader } = await sentOne();
      reader.queue.push(
        inbound({
          from: "mailer-daemon@googlemail.com",
          subject: "Delivery Status Notification (Failure)",
          contentType: "multipart/report; report-type=delivery-status",
          attachmentsText: [`Final-Recipient: rfc822; ${c.email}\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 user unknown`, `Message-ID: ${m.rfcMessageId}`],
        }),
      );
      const stats = await runIngest(ctx, () => reader);
      expect(stats.bouncesHard).toBe(1);
      const sup = await ctx.db.select().from(suppression);
      expect(sup.map((s) => s.email)).toContain(c.email);
      const [ev] = await ctx.db.select().from(events).where(eq(events.type, "bounced_hard"));
      expect(ev!.mailboxId).toBe(m.mailboxId);
      expect(ev!.messageId).toBe(m.id);
    });

    it("a bounce of mail we never sent (warm-up traffic) suppresses nobody and doesn't count against the mailbox", async () => {
      const { reader } = await sentOne();
      reader.queue.push(
        inbound({
          from: "mailer-daemon@googlemail.com",
          subject: "Delivery Status Notification (Failure)",
          contentType: "multipart/report; report-type=delivery-status",
          attachmentsText: [`Final-Recipient: rfc822; oliver.baker@reach.vendor.example\nAction: failed\nStatus: 5.7.0\nDiagnostic-Code: smtp; 550 5.7.0 rejected`, `Message-ID: <warmup-123@pool.example>`],
        }),
      );
      await runIngest(ctx, () => reader);
      expect(await ctx.db.select().from(suppression)).toEqual([]);
      const [ev] = await ctx.db.select().from(events).where(eq(events.type, "bounced_hard"));
      expect(ev!.messageId).toBeNull();
      const report = await runHealthCheck(ctx);
      expect(report.every((r) => r.hardBounces === 0)).toBe(true);
    });
  });
});
