import { readFileSync } from "node:fs";
import path from "node:path";
import { applyProjectDocs, ConfigError, contacts, events, facts, loadProjectDocs, meetings, messages, newReplyText, replies, saveProjectDocs, suppression, threads, type ReplyLabel } from "@opengtm/core";
import { createTestCtx, FakeLlm, testConfig, type TestCtx } from "@opengtm/core/testing";
import { applyReplyActions, approveAndSendReply, recheckAwayNotices, checkReplyDraft, classifyReply, holdAutoReply, MemoryCrmSink, parseReturnDate, preClassify, runAutoReplies, runReplies } from "@opengtm/replies";
import { ensureDefaultCampaigns, FakeTransport, runEnroll, runSchedule, runSendTick } from "@opengtm/sequencer";
import { runWrite, stripFooter } from "@opengtm/writer";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { goodDraft, passingCritic, seedCompany, seedMailbox } from "./fixtures";

type Sample = { label: ReplyLabel; subject: string; body: string; headers?: Record<string, string> };
const samples: Sample[] = JSON.parse(readFileSync(path.join(__dirname, "fixtures/replies.json"), "utf8"));

const draftBody = "Thanks for the quick reply, Ana. Happy to show you how scheduling and reminders work in Northwind for a company your size. Pick any time that suits you here: https://cal.example.com/northwind-intro and I'll keep it to twenty minutes or less.";

describe("reply handling", () => {
  let ctx: TestCtx;
  afterEach(async () => ctx?.close());

  it("ships 30 labeled samples covering every label", () => {
    expect(samples).toHaveLength(30);
    expect(new Set(samples.map((s) => s.label)).size).toBe(11);
  });

  it("rule pre-classifier is never wrong when it fires", () => {
    const now = new Date("2026-10-21T15:00:00Z");
    let fired = 0;
    for (const s of samples) {
      const r = preClassify({ subject: s.subject, body: s.body, classifiedBy: s.headers?.["auto-submitted"] ? "headers:auto_reply" : null }, now);
      if (!r) continue;
      fired++;
      expect(r.label, s.body).toBe(s.label);
    }
    expect(fired).toBeGreaterThanOrEqual(4);
  });

  it("treats a mail app's Unsubscribe button (subject only, empty body) as an unsubscribe", () => {
    const now = new Date("2026-10-21T15:00:00Z");
    expect(preClassify({ subject: "unsubscribe", body: "", classifiedBy: null }, now)?.label).toBe("unsubscribe");
    expect(preClassify({ subject: "Unsubscribe", body: "\n", classifiedBy: null }, now)?.label).toBe("unsubscribe");
    expect(preClassify({ subject: "unsubscribe", body: "Actually, can we talk Tuesday?", classifiedBy: null }, now)).toBeNull();
  });

  it("a stretched 'yesss' or a plain yes is a hot lead", () => {
    const now = new Date("2026-11-02T20:00:00Z");
    const ourLastEmail = 'Want to see how your hvac company would run on Northwind for $0? Just reply "yesss" and I\'ll send you a preview.';
    for (const body of ["yesss", "Yesss!", "yes", "Yesss please", "yesss thanks"]) {
      const r = preClassify({ subject: "Re: Furnace repair", body, classifiedBy: null, ourLastEmail }, now);
      expect(r?.label, body).toBe("interested");
      expect(r?.hot, body).toBe(true);
    }
    expect(preClassify({ subject: "Re: Furnace repair", body: "yesss but what does it cost after a year?", classifiedBy: null, ourLastEmail }, now)).toBeNull();
  });

  // Found comparing against OtherTool's labels on real replies: these auto-replies were being read as vacations.
  it("reads moved and dead mailboxes in auto-replies before out-of-office", () => {
    const now = new Date("2026-10-26T15:00:00Z");
    const pc = (subject: string, body: string) => preClassify({ subject, body, classifiedBy: null, fromEmail: "old@company.example" }, now);
    expect(pc("Automatic reply: Case management", "Please note that my contact information has changed. You may reach me at:\nNew Company PLLC\nEmail: jane@newfirm.example")).toMatchObject({ label: "email_changed", newEmail: "jane@newfirm.example" });
    expect(pc("Automatic reply: Landscaping", "You have used his old email address, old@company.example. Please direct your email to Mike's current email address: mike@other.example.")).toMatchObject({ label: "email_changed", newEmail: "mike@other.example" });
    expect(pc("Automatic reply: Case management", "This company has merged. This email address will not be monitored after January 31. You may reach me at jeff@merged.example.")).toMatchObject({ label: "email_changed", newEmail: "jeff@merged.example" });
    expect(pc("Automatic reply: Wills", "Victoria Powers has retired from the practice of law. Please call our office.")?.label).toBe("recipient_gone");
    expect(pc("Re: Wills", "From: old@company.example\nSubject: I am no longer checking this email.\n\nThis email is no longer in use.")?.label).toBe("recipient_gone");
    for (const dead of [
      "This email address is no longer active.",
      "This mailbox is inactive and is not monitored.",
      "The email account you sent to has been deactivated.",
      "This inbox is not being monitored.",
      "This address is no longer valid. Please contact info@company.example instead.",
    ]) {
      expect(pc("Automatic reply: Practice management", dead)?.label, dead).toMatch(/^(recipient_gone|email_changed)$/);
    }
    // A person mentioning a closed account is not a dead mailbox.
    expect(pc("Re: Billing", "Our Jobber account was closed last year, so we're looking. What does Northwind cost?")).toBeNull();
    expect(pc("Automatic reply: Closings", "I am out of the office until October 27. Please contact my dispatcher at para@company.example.")?.label).toBe("out_of_office");
    // A person (not an auto-reply) saying where to reach them is left for the model, which may well be a hot lead.
    expect(pc("Re: Case files", "Interested. Reach me at jane@company.example and let's talk.")).toBeNull();
  });

  it("parses out-of-office return dates", () => {
    const now = new Date("2026-10-21T15:00:00Z");
    expect(parseReturnDate("out of the office until November 2 with limited access", now)?.toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(parseReturnDate("will return on 11/9. I will respond", now)?.toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(parseReturnDate("back on Jan 5th", now)?.toISOString().slice(0, 10)).toBe("2027-01-05");
    expect(parseReturnDate("I'm in trial through the end of next week", now)).toBeNull();
  });

  it("reads only what the prospect wrote: no quoted history, notices or image tags", () => {
    expect(newReplyText("sure :) On Fri, Oct 23, 2026 at 6:29 AM Daniela <daniela@x.example> wrote: > Hi Tiffany, > > I came across")).toBe("sure :)");
    expect(newReplyText("Sounds good.\n\nOn Fri, Oct 23, 2026 at 6:29 AM Daniela <\ndaniela@x.example> wrote:\n> Hi")).toBe("Sounds good.");
    expect(newReplyText("No thank you.\nFrom: Brian Carter <b@x.example>\nSent: Thursday, October 22, 2026 2:40 PM\nTo: Robert")).toBe("No thank you.");
    expect(newReplyText("no thank you\n\n--- NOTICE OF CONFIDENTIALITY: The information contained in this message is private.")).toBe("no thank you");
    expect(newReplyText("I am not interested at this time. [image: photo] <https://hasan-cleaning.example/>\nCONFIDENTIALITY NOTICE: privileged")).toBe("I am not interested at this time.");
    expect(newReplyText("Do you support LawPay?\n\nSent from my iPhone")).toBe("Do you support LawPay?");
    // A "From:" in the middle of a sentence is not quoted history.
    expect(newReplyText("From: what I can see it might help.\nCan you send it?")).toContain("Can you send it?");
  });

  it("a short yes to our 'reply yes' email is a hot lead; a bare no thanks needs no answer", () => {
    const now = new Date("2026-10-21T15:00:00Z");
    const ours = 'Hi Tiffany, ... Just reply "yes" and I\'ll send the preview.';
    const yes = preClassify({ subject: "Re: closings", body: "sure :)\n\nOn Fri, Oct 23, 2026 at 6:29 AM Daniela <d@x.example> wrote:\n> Hi", classifiedBy: null, ourLastEmail: ours }, now);
    expect(yes).toMatchObject({ label: "interested", hot: true, replyNeeded: true });
    expect(preClassify({ subject: "Re: x", body: "👍", classifiedBy: null, ourLastEmail: ours }, now)?.label).toBe("interested");
    // Without our "reply yes" ask, a thumbs up is left to the model.
    expect(preClassify({ subject: "Re: x", body: "👍", classifiedBy: null }, now)).toBeNull();
    expect(preClassify({ subject: "Re: x", body: "yes, but what does it cost?", classifiedBy: null, ourLastEmail: ours }, now)).toBeNull();
    for (const no of ["no thank you\n\n--- NOTICE OF CONFIDENTIALITY: private", "I am not interested at this time.", "No thanks.", "We're all set, thanks"]) {
      expect(preClassify({ subject: "Re: x", body: no, classifiedBy: null }, now), no).toMatchObject({ label: "objection", replyNeeded: false, hot: false });
    }
    expect(preClassify({ subject: "Re: x", body: "No thanks, we just renewed with Housecall Pro. Maybe next year?", classifiedBy: null }, now)).toBeNull();
  });

  it("reply drafts may quote pricing, and a hot reply must offer the founders call at the booking link", async () => {
    ctx = await createTestCtx({ config: testConfig((raw) => { raw.business.company.pricing = "$84 per user per month"; }) });
    const link = ctx.config.business.company.booking_link;
    const ok = `Hi Ana, it's $84 per user per month. Here's the free preview at northwind.example.com. Would a call with our founders help? You can book one here: ${link}`;
    expect(checkReplyDraft(ctx, ok, [], "question", true).map((i) => i.code)).toEqual([]);
    const noAsk = `Hi Ana, it's $84 per user per month. Here's the free preview: ${link}. Let me know what you think of it.`;
    expect(checkReplyDraft(ctx, noAsk, [], "question", true).map((i) => i.code)).toContain("no_next_step");
    const invented = `Hi Ana, companies save 40% of admin time with Northwind. Here's the preview at northwind.example.com. Would a call with our founders help? Book here: ${link}`;
    expect(checkReplyDraft(ctx, invented, [], "question", true).map((i) => i.code)).toContain("unsupported_number");
  });

  it("escalates low-confidence local labels to the API model", async () => {
    const llm = new FakeLlm()
      .on("reply_classify", () => ({ label: "other", confidence: 0.3, summary: "unsure", referral: null, ooo_until: null, remove_whole_company: false }))
      .on("reply_classify_escalate", () => ({ label: "objection", confidence: 0.9, summary: "renewed with Housecall Pro", referral: null, ooo_until: null, remove_whole_company: false }));
    ctx = await createTestCtx({ llm });
    const s = samples.find((x) => x.label === "objection")!;
    const res = await classifyReply(ctx, { subject: s.subject, body: s.body, classifiedBy: null, fromEmail: "a@b.example" });
    expect(res.label).toBe("objection");
    expect(res.by).toMatch(/^escalated:/);
  });

  // ---- actions, on a real sent thread ----
  async function sentThread() {
    const llm = new FakeLlm()
      .on("critic", passingCritic)
      .on("write_email", () => goodDraft(["f2"]))
      .on("reply_draft", () => ({ body: draftBody, proof_point_ids: [] }));
    const config = testConfig((raw) => {
      raw.engine.approval.force_all = false;
      raw.engine.approval.require_first_n = 0;
      raw.engine.approval.sample_rate = 0;
    });
    ctx = await createTestCtx({ llm, config, start: "2026-10-20T12:00:00Z" });
    await ensureDefaultCampaigns(ctx);
    const mb = await seedMailbox(ctx);
    const company = await seedCompany(ctx);
    const transport = new FakeTransport(() => ctx.clock.now());
    const deps = { transportFor: () => transport, publicBaseUrl: "https://gtm.example.com", unsubscribeSecret: "s" };
    await runEnroll(ctx, 10);
    await runWrite(ctx, 10);
    await runSchedule(ctx);
    ctx.clock.set("2026-10-20T17:00:00Z");
    await runSendTick(ctx, deps);
    const [m] = await ctx.db.select().from(messages).where(eq(messages.status, "sent"));
    expect(m).toBeDefined();
    const addReply = async (body: string, extra: Partial<typeof replies.$inferInsert> = {}) => {
      const [r] = await ctx.db
        .insert(replies)
        .values({ threadId: m!.threadId, messageId: m!.id, contactId: m!.contactId, mailboxId: mb.id, fromEmail: company.contact.email, subject: `Re: ${m!.subject}`, body, receivedAt: ctx.clock.now(), rfcMessageId: `<reply-${Math.random()}@prospect.example>`, ...extra })
        .returning();
      return r!;
    };
    return { llm, mb, company, m: m!, transport, deps, addReply, crm: new MemoryCrmSink() };
  }

  const cls = (label: ReplyLabel, extra: Partial<Parameters<typeof applyReplyActions>[2]> = {}) => ({
    label,
    confidence: 0.9,
    summary: `${label} reply`,
    referral: null,
    oooUntil: null,
    removeWholeCompany: false,
    by: "test",
    ...extra,
  });

  it("auto-replies like OtherTool: drafts wait out the review window, then send; hot leads wait for a person", async () => {
    const w = await sentThread();
    // A "not for us, we use X" objection still deserves an answer: OtherTool drafts and auto-sends those.
    const q = await w.addReply("We already use Jobber, so probably not.");
    await applyReplyActions(ctx, q.id, cls("objection", { replyNeeded: true }), { crm: w.crm });
    const [drafted] = await ctx.db.select().from(replies).where(eq(replies.id, q.id));
    expect(drafted!.draftState).toBe("pending");
    expect(drafted!.autoSendAt!.getTime() - ctx.clock.now().getTime()).toBe(240 * 60_000);

    ctx.clock.set(new Date(ctx.clock.now().getTime() + 60_000).toISOString());
    const hot = await w.addReply("Actually, yes, show me.", { rfcMessageId: "<hot@prospect.example>" });
    await applyReplyActions(ctx, hot.id, cls("interested"), { crm: w.crm });
    const [hotRow] = await ctx.db.select().from(replies).where(eq(replies.id, hot.id));
    expect(hotRow!.hot).toBe(true);
    expect(hotRow!.autoSendAt).toBeNull();

    const before = w.transport.sent.length;
    expect(await runAutoReplies(ctx, w.deps)).toEqual({ sent: 0, heldForPerson: 0 }); // still inside the window
    ctx.clock.set(new Date(ctx.clock.now().getTime() + 241 * 60_000).toISOString());
    // The hot lead's later message makes the question's draft stale: it goes back to a person.
    expect(await runAutoReplies(ctx, w.deps)).toEqual({ sent: 0, heldForPerson: 1 });
    expect(w.transport.sent.length).toBe(before);
  });

  it("sends a due auto-reply, and never one a person held", async () => {
    const w = await sentThread();
    const q = await w.addReply("We're happy with Housecall Pro for now.");
    await applyReplyActions(ctx, q.id, cls("objection", { replyNeeded: true }), { crm: w.crm });
    ctx.clock.set(new Date(ctx.clock.now().getTime() + 5 * 3600_000).toISOString());
    expect(await runAutoReplies(ctx, w.deps)).toEqual({ sent: 1, heldForPerson: 0 });
    const [done] = await ctx.db.select().from(replies).where(eq(replies.id, q.id));
    expect(done).toMatchObject({ draftState: "sent", handled: true });

    const q2 = await w.addReply("Also, we're mid-year, bad timing.", { rfcMessageId: "<q2@prospect.example>" });
    await applyReplyActions(ctx, q2.id, cls("objection", { replyNeeded: true }), { crm: w.crm });
    await holdAutoReply(ctx, q2.id, "dean");
    ctx.clock.set(new Date(ctx.clock.now().getTime() + 5 * 3600_000).toISOString());
    expect(await runAutoReplies(ctx, w.deps)).toEqual({ sent: 0, heldForPerson: 0 });
  });

  it("interested: marks hot, opens a meeting, alerts, drafts a reply that a human can send in one click", async () => {
    const w = await sentThread();
    const r = await w.addReply("Yes, send me some times next week.");
    expect(await applyReplyActions(ctx, r.id, cls("interested"), { crm: w.crm })).toBe("hot_lead_drafted");
    const [after] = await ctx.db.select().from(replies).where(eq(replies.id, r.id));
    expect(after!.hot).toBe(true);
    expect(after!.draftState).toBe("pending");
    expect(after!.draftBody).toContain("https://cal.example.com/northwind-intro");
    expect(after!.draftBody).toContain('Reply "stop"');
    expect(await ctx.db.select().from(meetings)).toHaveLength(1);
    expect(ctx.sink.alerts.some((a) => a.key === `hot_lead:${r.id}`)).toBe(true);
    expect(w.crm.records).toHaveLength(1);

    const sentId = await approveAndSendReply(ctx, r.id, "dean", w.deps);
    const [sent] = await ctx.db.select().from(messages).where(eq(messages.id, sentId));
    expect(sent!.kind).toBe("reply");
    const [done] = await ctx.db.select().from(replies).where(eq(replies.id, r.id));
    expect(done).toMatchObject({ draftState: "sent", handled: true }); // no longer "Needs reply"
    expect(sent!.inReplyTo).toBe(r.rfcMessageId);
    expect(sent!.references).toContain(w.m.rfcMessageId!);
    expect(w.transport.sent.at(-1)!.email.subject).toBe(`Re: ${w.m.subject}`);
    await expect(approveAndSendReply(ctx, r.id, "dean", w.deps)).rejects.toThrow("already sent");
  });

  it("reads each reply in the context of the thread and drops a bare 'no thanks' without drafting", async () => {
    const w = await sentThread();
    let seen = "";
    w.llm.on("reply_classify", (input) => {
      seen = input.prompt;
      return { label: "question", confidence: 0.9, summary: "Asks about LawPay", referral: null, ooo_until: null, remove_whole_company: false, hot: true, reply_needed: true, questions: ["Do you support LawPay?"], next_step: "Answer, then offer a demo" };
    });
    const q = await w.addReply("Do you support LawPay?\n\nOn Tue, Oct 20, 2026 at 1:00 PM Pat <pat@x.example> wrote:\n> earlier");
    await runReplies(ctx, { crm: w.crm });
    expect(seen).toContain(w.m.body.split("\n--\n")[0]!.slice(0, 40)); // our email, in the conversation
    expect(seen).toContain("They are:");
    expect(seen).not.toContain("> earlier");
    const [qa] = await ctx.db.select().from(replies).where(eq(replies.id, q.id));
    expect(qa!.hot).toBe(true);
    expect(qa!.summary).toContain("Asks: Do you support LawPay?");
    expect(qa!.draftBody).toBeTruthy();
    const [mt] = await ctx.db.select().from(meetings);
    expect(mt!.nextStep).toBe("Answer, then offer a demo");

    expect(ctx.sink.alerts.some((a) => a.key === `hot_lead:${q.id}` && a.body.includes("Do you support LawPay?") && !a.body.includes("> earlier"))).toBe(true);
    const no = await w.addReply("no thank you\n\n--- NOTICE OF CONFIDENTIALITY: private", { rfcMessageId: "<no@prospect.example>" });
    await runReplies(ctx, { crm: w.crm });
    const [after] = await ctx.db.select().from(replies).where(eq(replies.id, no.id));
    expect(after).toMatchObject({ label: "objection", actionTaken: "not_interested", handled: true, hot: false, draftBody: null });
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, w.company.contact.id));
    expect(c).toMatchObject({ status: "dropped", dropReason: "not interested" });
    // Teammates who want every reply get one about the "no thank you" too.
    expect(ctx.sink.alerts.find((a) => a.key === `reply:${no.id}`)).toMatchObject({ level: "info", body: expect.stringContaining("no thank you") });
  });

  it("not_now: snoozes the contact for the re-touch window", async () => {
    const w = await sentThread();
    const r = await w.addReply("Try me in the spring.");
    await applyReplyActions(ctx, r.id, cls("not_now"), { crm: w.crm });
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, w.company.contact.id));
    expect(c!.status).toBe("snoozed");
    const days = (c!.retouchAt!.getTime() - ctx.clock.now().getTime()) / 86_400_000;
    expect(days).toBe(ctx.config.engine.replies.retouch_days);
  });

  it("referral: adds the referred person as a new lead with source 'referral'", async () => {
    const w = await sentThread();
    const domain = w.company.company.domain;
    const r = await w.addReply(`Please talk to Dana, our company administrator: dana@${domain}`);
    expect(await applyReplyActions(ctx, r.id, cls("referral", { referral: { name: "Dana Whitfield", email: null, title: "Company Administrator" } }), { crm: w.crm })).toBe("referral_added");
    const [dana] = await ctx.db.select().from(contacts).where(eq(contacts.email, `dana@${domain}`));
    expect(dana!.source).toBe("referral");
    expect(dana!.status).toBe("new");
    expect(dana!.firstName).toBe("Dana");
  });

  it("out_of_office: pauses the next step until after the return date", async () => {
    const w = await sentThread();
    const r = await w.addReply("I am out of the office until November 2.", { classifiedBy: "headers:auto_reply" });
    await runReplies(ctx, { crm: w.crm });
    const [t] = await ctx.db.select().from(threads).where(eq(threads.id, w.m.threadId));
    expect(t!.status).toBe("active");
    expect(t!.pausedUntil!.toISOString().slice(0, 10)).toBe("2026-11-03");
    void r;
    // Step 2 would be due ~Oct 23; nothing goes out before Nov 3.
    ctx.clock.set("2026-10-23T17:00:00Z");
    await runSchedule(ctx);
    for (let i = 0; i < 20; i++) {
      await runSendTick(ctx, w.deps);
      ctx.clock.advance(30 * 60_000);
    }
    const step2 = await ctx.db.select().from(messages).where(and(eq(messages.threadId, w.m.threadId), eq(messages.stepNumber, 2)));
    expect(step2[0]!.status).not.toBe("sent");
    expect(step2[0]!.scheduledFor!.getTime()).toBeGreaterThanOrEqual(new Date("2026-11-03T00:00:00Z").getTime());
  });

  it("unsubscribe for the whole company suppresses the domain permanently", async () => {
    const w = await sentThread();
    const r = await w.addReply("Please don't email anyone at our company again.");
    await applyReplyActions(ctx, r.id, cls("unsubscribe", { removeWholeCompany: true }), { crm: w.crm });
    const sup = await ctx.db.select().from(suppression);
    expect(sup.map((s) => s.domain)).toContain(w.company.company.domain);
    expect(sup.map((s) => s.email)).toContain(w.company.contact.email);
  });

  it("hostile: suppresses and records a complaint against the sending mailbox", async () => {
    const w = await sentThread();
    const r = await w.addReply("This is spam, I'm reporting you.");
    await applyReplyActions(ctx, r.id, cls("hostile"), { crm: w.crm });
    const [ev] = await ctx.db.select().from(events).where(eq(events.type, "complaint"));
    expect(ev!.mailboxId).toBe(w.mb.id);
    expect((await ctx.db.select().from(suppression)).length).toBe(1);
  });

  // ---- handling the whole conversation (OtherTool parity) ----
  it("someone who moved companies: drops the old address and adds the new one as a lead", async () => {
    const w = await sentThread();
    const r = await w.addReply("Thank you for your message. Note that I have joined Banker Lopez Gassler and my new email address is rbuchanan@bankerlopez.com. Please update your records.");
    await runReplies(ctx, { crm: w.crm });
    const [row] = await ctx.db.select().from(replies).where(eq(replies.id, r.id));
    expect(row).toMatchObject({ label: "email_changed", actionTaken: "email_changed:rbuchanan@bankerlopez.com", handled: true });
    const [moved] = await ctx.db.select().from(contacts).where(eq(contacts.email, "rbuchanan@bankerlopez.com"));
    expect(moved).toMatchObject({ status: "new", firstName: w.company.contact.firstName });
    const [old] = await ctx.db.select().from(contacts).where(eq(contacts.id, w.company.contact.id));
    expect(old).toMatchObject({ status: "suppressed", dropReason: "moved to rbuchanan@bankerlopez.com" });
  });

  it("someone who left without a new address is dropped, not emailed again", async () => {
    const w = await sentThread();
    const r = await w.addReply("Robert is no longer with the company. Please remove him from your list.");
    await runReplies(ctx, { crm: w.crm });
    const [row] = await ctx.db.select().from(replies).where(eq(replies.id, r.id));
    expect(row).toMatchObject({ label: "recipient_gone", actionTaken: "recipient_gone" });
    const [old] = await ctx.db.select().from(contacts).where(eq(contacts.id, w.company.contact.id));
    expect(old).toMatchObject({ status: "suppressed", dropReason: "no longer at the company" });
  });

  // Reported 2026-11-01: an auto-reply saying the mailbox is no longer active, and the follow-up still went out.
  // Auto-replies don't stop the thread when they arrive, so the classifier has to.
  it("an auto-reply saying the mailbox is dead cancels the queued follow-up", async () => {
    const w = await sentThread();
    const queued = async () => (await ctx.db.select().from(messages).where(eq(messages.threadId, w.m.threadId))).filter((x) => x.status === "scheduled" || x.status === "draft");
    expect((await queued()).length).toBeGreaterThan(0);
    await w.addReply("Thank you for your email. This email address is no longer active. Please call our main line.", { subject: "Automatic reply: scheduling software", classifiedBy: "headers:auto_reply" });
    await runReplies(ctx, { crm: w.crm });
    expect(await queued()).toEqual([]);
    const [t] = await ctx.db.select().from(threads).where(eq(threads.id, w.m.threadId));
    expect(t!.status).toBe("stopped");
    expect((await ctx.db.select().from(suppression)).map((x) => x.email)).toContain(w.company.contact.email.toLowerCase());
    ctx.clock.set("2026-10-26T17:00:00Z");
    await runSendTick(ctx, w.deps);
    expect(w.transport.sent.length).toBe(1);
  });

  it("re-reads past away notices with the current rules and stops dead mailboxes, without re-alerting", async () => {
    const w = await sentThread();
    // Labeled "away" by the older rules, so the thread was only paused.
    await w.addReply("This email account has been deactivated.", { subject: "Automatic reply: scheduling software", classifiedBy: "headers:auto_reply", label: "out_of_office", handled: true });
    expect((await recheckAwayNotices(ctx, { crm: w.crm })).restopped).toBe(1);
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, w.company.contact.id));
    expect(c!.status).toBe("suppressed");
    expect(ctx.sink.alerts.some((a) => a.key.startsWith("reply:"))).toBe(false);
    expect((await recheckAwayNotices(ctx, { crm: w.crm })).restopped).toBe(0);
  });

  it("never sends to a dropped contact, even with a follow-up already queued", async () => {
    const w = await sentThread();
    await ctx.db.update(contacts).set({ status: "dropped", dropReason: "not interested" }).where(eq(contacts.id, w.company.contact.id));
    for (const day of ["2026-10-23T17:00:00Z", "2026-10-24T17:00:00Z", "2026-10-26T17:00:00Z"]) {
      ctx.clock.set(day);
      await runSendTick(ctx, w.deps);
    }
    expect(w.transport.sent.length).toBe(1);
    const [t] = await ctx.db.select().from(threads).where(eq(threads.id, w.m.threadId));
    expect(t).toMatchObject({ status: "stopped", stopReason: "contact dropped: not interested" });
  });

  it("replies copy the configured person, and a typed reply gets the standard signature", async () => {
    const w = await sentThread();
    w.llm.on("reply_classify", () => ({ label: "interested", confidence: 0.95, summary: "wants a look", referral: null, ooo_until: null, remove_whole_company: false }));
    ctx.config.business.outreach.reply_cc = ["sam@northwind.example.com"];
    const r = await w.addReply("sure :)");
    await runReplies(ctx, { crm: w.crm });
    await approveAndSendReply(ctx, r.id, "test", w.deps, { body: "Great, here is the preview: https://northwind.example.com" });
    const sent = w.transport.sent.at(-1)!;
    expect(sent.email.cc).toEqual(["sam@northwind.example.com"]);
    expect(sent.mime).toMatch(/^Cc: sam@northwind\.example\.com/m);
    expect(sent.email.text).toContain("\nBest,\n");
    expect(sent.email.text).toContain(ctx.config.business.company.physical_address);
  });

  it("a hot lead who writes again stays one conversation: the alert says 'replied again', and answering it answers the earlier reply too", async () => {
    const w = await sentThread();
    w.llm.on("reply_classify", (input) =>
      input.prompt.includes("reporting")
        ? { label: "question", confidence: 0.9, summary: "Asks how reporting compares with Jobber", referral: null, ooo_until: null, remove_whole_company: false, hot: true }
        : { label: "interested", confidence: 0.97, summary: "Said yes", referral: null, ooo_until: null, remove_whole_company: false, hot: true },
    );
    const first = await w.addReply("yes");
    await runReplies(ctx, { crm: w.crm });
    ctx.clock.advance(60 * 60_000);
    const second = await w.addReply("I do not see reporting features? How does reporting compare with Jobber?", { receivedAt: ctx.clock.now() });
    await runReplies(ctx, { crm: w.crm });

    const titles = ctx.sink.alerts.filter((a) => a.key.startsWith("hot_lead:")).map((a) => a.title);
    expect(titles[0]).toMatch(/^Hot lead: /);
    expect(titles[1]).toMatch(/replied again$/);
    expect(await ctx.db.select().from(meetings)).toHaveLength(1);

    await approveAndSendReply(ctx, second.id, "test", w.deps, { body: "Hi Ana,\n\nGood question, I'll confirm with the team." });
    const [older] = await ctx.db.select().from(replies).where(eq(replies.id, first.id));
    expect(older!.handled).toBe(true);
    expect(older!.draftState).toBe("rejected"); // its unsent draft won't go out as well
  });

  it("a plain yes gets the team's own reply word for word, and a hot lead gets demo prep tied to its sources", async () => {
    const w = await sentThread();
    w.llm.on("reply_classify", () => ({ label: "interested", confidence: 0.97, summary: "Said yes to the free preview", referral: null, ooo_until: null, remove_whole_company: false, hot: true }));
    const [fact] = await ctx.db.select().from(facts).where(eq(facts.companyId, w.company.company.id));
    w.llm.on("lead_brief", () => ({
      headline: "Ana runs a hvac company and said yes to the preview.",
      person: ["Managing partner"],
      company: [
        { text: fact!.text, fact_id: "f1" },
        { text: "Won a national award in 2024", fact_id: "f99" }, // not a fact we have: dropped
        { text: "Based in Austin, TX", fact_id: null },
      ],
      current_tools: null,
      show_them: [{ feature: "Dispatch board", why: "Six technicians to schedule" }],
      questions: ["What do you use today?"],
      watch_outs: [],
    }));
    ctx.config.business.outreach.yes_reply = "Hi {{first_name}},\n\nThanks for the quick reply. Here's the 2-minute video: https://northwind.example.com/video\n\nIf you'd like a closer look, pick a time here:\n\n{{booking_link}}";
    const r = await w.addReply("Yesss");
    await runReplies(ctx, { crm: w.crm });
    const [after] = await ctx.db.select().from(replies).where(eq(replies.id, r.id));
    expect(after!.hot).toBe(true);
    expect(stripFooter(after!.draftBody!)).toBe(
      `Hi Ana,\n\nThanks for the quick reply. Here's the 2-minute video: https://northwind.example.com/video\n\nIf you'd like a closer look, pick a time here:\n\n${ctx.config.business.company.booking_link}`,
    );
    expect(w.llm.calls.some((c) => c.task === "reply_draft")).toBe(false);

    const [hl] = await ctx.db.select().from(meetings).where(eq(meetings.replyId, r.id));
    expect(hl!.brief!.headline).toContain("said yes");
    expect(hl!.brief!.company).toEqual([
      { text: fact!.text, source: fact!.sourceUrl },
      { text: "Based in Austin, TX", source: null },
    ]);
  });

  it("a reply sent from the inbox box with its own 'Best, <name>' gets the sign-off once, then the same signature and logo as the first email", async () => {
    const w = await sentThread();
    w.llm.on("reply_classify", () => ({ label: "interested", confidence: 0.95, summary: "wants a look", referral: null, ooo_until: null, remove_whole_company: false }));
    const r = await w.addReply("Yesss");
    await runReplies(ctx, { crm: w.crm });
    const first = w.transport.sent[0]!;
    await approveAndSendReply(ctx, r.id, "test", w.deps, { body: "Hi Ana,\n\nHere's the preview.\n\nBest,\nDaniela\n" });
    const sent = w.transport.sent.at(-1)!;
    expect(sent.email.text.match(/\nBest,\n/g)).toHaveLength(1);
    expect(sent.email.html).toBeTruthy();
    expect(sent.email.html).toContain(">Jamie Rivera<");
    expect(first.email.html).toContain(">Jamie Rivera<"); // the same signature block as the email they answered
  });

  it("project docs override business.yaml and bad input is refused without saving", async () => {
    ctx = await createTestCtx();
    const base = ctx.config;
    const next = await saveProjectDocs(ctx.db, base, { company: { offer: "a free preview" }, competitors: ["Jobber"], outreach: { reply_cc: ["sam@northwind.example.com"] } }, "test");
    expect(next.business.company.offer).toBe("a free preview");
    expect(next.business.company.name).toBe(base.business.company.name);
    expect(applyProjectDocs(base, await loadProjectDocs(ctx.db)).business.competitors).toEqual(["Jobber"]);
    await expect(saveProjectDocs(ctx.db, base, { outreach: { reply_cc: ["not-an-email"] } }, "test")).rejects.toBeInstanceOf(ConfigError);
    expect((await loadProjectDocs(ctx.db)).outreach?.reply_cc).toEqual(["sam@northwind.example.com"]);
  });
});
