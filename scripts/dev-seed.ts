/**
 * Fill a LOCAL dev database with realistic demo data by running the real
 * pipeline with a scripted LLM and fake mail transport. Nothing leaves the
 * machine and no API is called.
 *   pnpm dev:db          # in another terminal
 *   pnpm gtm migrate && pnpm dev:seed
 */
import { Alerter, ConsoleSink, createDb, createLogger, ManualClock, replies, startOfUtcDay, type Ctx } from "@opengtm/core";
import { FakeLlm, seededRandom, testConfig } from "@opengtm/core/testing";
import { runHealthCheck } from "@opengtm/health";
import { runWeeklyDigest } from "@opengtm/learning";
import { MemoryCrmSink, runReplies } from "@opengtm/replies";
import { ensureDefaultCampaigns, FakeTransport, runEnroll, runSchedule, runSendTick } from "@opengtm/sequencer";
import { approveMessage, runWrite } from "@opengtm/writer";
import { messages } from "@opengtm/core";
import { and, eq } from "drizzle-orm";
import { goodDraft, passingCritic, seedCompany, seedMailbox } from "../tests/fixtures";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("dev-seed only runs against a localhost DATABASE_URL");
  process.exit(1);
}
const { db, close } = createDb(url, { max: 1 }); // one connection: the dev database (pnpm dev:db) runs one query at a time
const log = createLogger("seed", "warn");
const now = new Date();
const clock = new ManualClock(new Date(startOfUtcDay(now).getTime() + 15 * 3_600_000)); // 10:00 Central today
const llm = new FakeLlm()
  .on("critic", passingCritic)
  .on("write_email", () => goodDraft(["f2"]))
  .on("reply_classify", (input) => {
    const b = input.prompt.toLowerCase();
    const label = b.includes("times") ? "interested" : b.includes("renewed") ? "objection" : b.includes("dana") ? "referral" : "other";
    return { label, confidence: 0.92, summary: `Prospect reply (${label})`, referral: label === "referral" ? { name: "Dana Whitfield", email: null, title: "Office Manager" } : null, ooo_until: null, remove_whole_company: false };
  })
  .on("reply_draft", () => ({
    body: "Thanks for getting back to me, Ana. Happy to walk you through scheduling and reminders in Northwind; it takes about twenty minutes. Grab whatever time suits you here: https://cal.example.com/northwind-intro",
    proof_point_ids: [],
  }))
  .on("segment_insights", () => ({
    headline: "Demo data: HVAC companies replied first; keep approving drafts daily.",
    top_segments: ["hvac"],
    worst_segments: [],
    actions: ["Approve the pending drafts in Approvals", "Reply to the hot lead in Inbox"],
  }));
const ctx: Ctx = { db, config: testConfig(), llm, clock, log, alerts: new Alerter(db, [new ConsoleSink(log)], clock, log), env: {}, random: seededRandom(7) };

await ensureDefaultCampaigns(ctx);
await seedMailbox(ctx, { email: "jamie@outreach-mail.example", domain: "outreach-mail.example", provider: "google" });
await seedMailbox(ctx, { email: "jamie@outreach-mail-two.example", domain: "outreach-mail-two.example", provider: "microsoft" });
const states = ["TX", "CA", "NY", "FL", "IL", "GA"];
for (let i = 0; i < 12; i++) await seedCompany(ctx, { state: states[i % states.length], provider: i % 2 ? "microsoft" : "google" });
await runEnroll(ctx, 50);
await runWrite(ctx, 50);

// Approve step 1 for half the threads (the rest stay in the Approvals queue).
const step1 = await db.select().from(messages).where(and(eq(messages.stepNumber, 1), eq(messages.status, "draft")));
for (const m of step1.slice(0, 6)) await approveMessage(ctx, m.id, "seed");
await runSchedule(ctx);
const transport = new FakeTransport(() => clock.now());
for (let i = 0; i < 40; i++) {
  await runSendTick(ctx, { transportFor: () => transport, publicBaseUrl: "http://localhost:3000", unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET ?? "dev-secret" });
  clock.advance(5 * 60_000);
}

const sent = await db.select().from(messages).where(eq(messages.status, "sent"));
const bodies = ["Good timing. Can you send a few times next week?", "We just renewed with Housecall Pro for a year, so not now.", "Please talk to Dana, our office manager, instead."];
for (const [i, m] of sent.slice(0, 3).entries()) {
  await db.insert(replies).values({ threadId: m.threadId, messageId: m.id, contactId: m.contactId, mailboxId: m.mailboxId!, fromEmail: "prospect@example.com", subject: `Re: ${m.subject}`, body: bodies[i]!, receivedAt: clock.now(), rfcMessageId: `<seed-reply-${m.id}@example.com>` });
}
await runReplies(ctx, { crm: new MemoryCrmSink() });
await runHealthCheck(ctx);
await runWeeklyDigest(ctx, async () => {});
console.log(`seeded: ${sent.length} sent, ${step1.length - 6} step-1 drafts awaiting approval, 3 replies`);
await close();
