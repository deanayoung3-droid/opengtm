/**
 * Live check of the whole reply flow on the configured model: read the reply in context, label it,
 * decide hot / no-reply, and draft the answer. Runs in a throwaway in-memory database; nothing is sent.
 *   OPENAI_API_KEY=... pnpm eval:drafts
 * To look at the result in the dashboard, point it at a scratch local database (never the real one):
 *   EVAL_DB_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres pnpm eval:drafts
 */
import { Alerter, campaigns, companies, ConsoleSink, contacts, createDb, createLlm, createLogger, decisionProvidersFromEnv, domains, facts, loadConfig, mailboxes, messages, providersFromEnv, replies, systemClock, threads } from "@opengtm/core";
import { createTestDb } from "@opengtm/core/testing";
import { checkReplyDraft, MemoryCrmSink, runReplies } from "@opengtm/replies";
import { ensureDefaultCampaigns, newMessageId } from "@opengtm/sequencer";
import { composeBody } from "@opengtm/writer";
import { eq } from "drizzle-orm";

const config = loadConfig();
const log = createLogger("eval", "warn");
const keep = process.env.EVAL_DB_URL;
if (keep && !/@(localhost|127\.0\.0\.1):55433\//.test(keep)) throw new Error("EVAL_DB_URL must be a scratch database on localhost:55433");
const { db, close } = keep ? createDb(keep) : await createTestDb();
const ctx = {
  db,
  config,
  clock: systemClock,
  log,
  env: process.env,
  random: Math.random,
  alerts: new Alerter(db, [new ConsoleSink(createLogger("eval", "silent"))], systemClock, log),
  llm: createLlm({ db, config, providers: providersFromEnv(config.llm, process.env), decisionProviders: decisionProvidersFromEnv(config.llm, process.env), clock: systemClock, log }),
};

const SCENARIOS: { reply: string; expect: string }[] = [
  { reply: "sure :)", expect: "interested, hot: the offer + demo time question" },
  { reply: "Do you already have something for maintenance plans?\n\nMark Ellison, Owner", expect: "question, hot: answers, then the offer + demo" },
  { reply: "How much is it? We're 6 technicians and 2 office staff. Also can we bring our customers over from Jobber?", expect: "question, hot: pricing + switching answer" },
  { reply: "We use Housecall Pro and it's fine for us.", expect: "objection: short, respectful, no demo push" },
  { reply: "no thank you\n\n--- CONFIDENTIALITY NOTICE: The information contained in this message is private.", expect: "objection, no reply, contact dropped" },
  { reply: "Please talk to Sam Ortiz, our office manager, instead: sam@{{domain}}", expect: "referral: Sam added as a lead" },
  { reply: "Who is this?", expect: "other: needs a human" },
];

/** Made-up people and companies. */
const PEOPLE: [string, string, string][] = [
  ["Tiffany", "Hale", "Lakeshore Heating Co."],
  ["Mark", "Ellison", "Ellison Air"],
  ["Ana", "Rivera", "Rivera Heating & Air"],
  ["James", "Hart", "Hart & Jones Mechanical"],
  ["Priya", "Natarajan", "Natarajan Cooling"],
  ["Dana", "Whitfield", "Whitfield Heating & Air"],
  ["Robert", "Burns", "Burns Plumbing"],
];

await ensureDefaultCampaigns(ctx);
await db.insert(domains).values({ name: "eval-mailbox.example" }).onConflictDoNothing();
const [dom] = await db.select().from(domains).where(eq(domains.name, "eval-mailbox.example"));
await db.insert(mailboxes).values({ email: "alex@eval-mailbox.example", provider: "google", transport: "fake", domainId: dom!.id, senderName: "Alex", senderTitle: "", status: "active", rampStartDate: new Date() }).onConflictDoNothing();
const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.email, "alex@eval-mailbox.example"));
const [camp] = await db.select().from(campaigns).limit(1);

let i = 0;
for (const s of SCENARIOS) {
  i++;
  const domain = `company${i}-${Date.now().toString(36)}.example`;
  const [first, last, company] = PEOPLE[(i - 1) % PEOPLE.length]!;
  const [co] = await db.insert(companies).values({ name: company, domain, website: `https://${domain}`, source: "eval", segmentId: camp!.segmentId, country: "US", state: "FL", status: "researched", focusAreas: ["hvac", "furnace repair"] }).returning();
  await db.insert(facts).values({ companyId: co!.id, text: "Installs and repairs heating and air conditioning across central Florida", sourceUrl: `https://${domain}/about`, fetchedAt: new Date(), kind: "services" });
  const [ct] = await db.insert(contacts).values({ companyId: co!.id, email: `${first.toLowerCase()}@${domain}`, firstName: first, lastName: last, title: "Owner", source: "eval", status: "enrolled", verifyStatus: "valid" }).returning();
  const [th] = await db.insert(threads).values({ contactId: ct!.id, companyId: co!.id, campaignId: camp!.id, mailboxId: mb!.id, status: "active", subject: "furnace repairs", variant: "A" }).returning();
  const sentAt = new Date(Date.now() - 6 * 3_600_000);
  const body = composeBody(
    `Hi ${first},\n\nI came across ${company} and saw you install and repair heating and air across central Florida.\n\nI'm Alex at ${config.business.company.name}. ${config.business.company.one_liner}.\n\nWant a quick look? Just reply "${config.business.outreach.cta_reply}" and I'll send it over.`,
    config,
    { name: "Alex", title: "" },
  );
  const [msg] = await db.insert(messages).values({ threadId: th!.id, contactId: ct!.id, kind: "sequence", stepNumber: 1, dayOffset: 0, variant: "A", subject: th!.subject ?? "", body, factIds: [], proofPointIds: [], costUsd: 0, approvalState: "approved", status: "sent", sendAttempts: 1, mailboxId: mb!.id, rfcMessageId: newMessageId(mb!.email), sentAt }).returning();
  await db.insert(replies).values({ threadId: th!.id, messageId: msg!.id, contactId: ct!.id, mailboxId: mb!.id, fromEmail: ct!.email, subject: `Re: ${th!.subject}`, body: s.reply.replace("{{domain}}", domain), receivedAt: new Date(Date.now() - i * 47 * 60_000), rfcMessageId: `<eval-${i}@${domain}>` });
}

await runReplies(ctx, { crm: new MemoryCrmSink() });

const rows = (await db.select({ r: replies, c: contacts }).from(replies).innerJoin(contacts, eq(contacts.id, replies.contactId)).orderBy(replies.rfcMessageId)).filter((x) => x.r.rfcMessageId?.startsWith("<eval-")).slice(-SCENARIOS.length);
for (const [n, { r, c }] of rows.entries()) {
  const s = SCENARIOS[n]!;
  const draft = (r.draftBody ?? "").split("\n--\n")[0]!.trim();
  const issues = draft ? checkReplyDraft(ctx, draft, [], r.label ?? "", r.hot).map((x) => x.code) : [];
  console.log(`\n━━ ${n + 1}. "${s.reply.split("\n")[0]}"\n   expected: ${s.expect}`);
  console.log(`   got: ${r.label} (${r.classifiedBy}, ${r.confidence?.toFixed(2)})  hot=${r.hot}  action=${r.actionTaken}  contact=${c.status}${c.dropReason ? ` (${c.dropReason})` : ""}`);
  console.log(`   summary: ${r.summary}`);
  if (draft) console.log(`   draft${issues.length ? ` [issues: ${issues.join(", ")}]` : " [passes checks]"}:\n${draft.replace(/^/gm, "     | ")}`);
}
const refs = await db.select().from(contacts).where(eq(contacts.source, "referral"));
console.log(`\nReferral leads added: ${refs.map((x) => x.email).join(", ") || "none"}`);
await close();
