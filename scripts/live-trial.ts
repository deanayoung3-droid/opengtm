/**
 * Real-data rehearsal with nothing sent: pull a few real companies from AI Ark,
 * research their real websites, and have the real model write their emails
 * into a LOCAL database so you can read them in Approvals.
 *   pnpm dev:db                                   # fresh local database
 *   pnpm gtm migrate && pnpm live:trial --credits 30
 * Uses OPENAI_API_KEY and AI_ARK_API_KEY. Mail goes to a fake mailbox only.
 * HUMAN fields that are still empty in business.yaml (address, sender) are filled
 * with visible [placeholders] in memory so drafts can be written.
 */
import { Alerter, ConsoleSink, createDb, createLlm, createLogger, getSetting, llmCalls, loadConfig, providersFromEnv, recordSpend, setSetting, systemClock, companies, contacts, facts, messages, type Ctx } from "@opengtm/core";
import { AiArkSource, runDiscover, runQualify } from "@opengtm/leads";
import { PoliteFetcher, runResearch } from "@opengtm/research";
import { ensureDefaultCampaigns, runEnroll } from "@opengtm/sequencer";
import { DnsMxResolver, MockVerifier, runVerify } from "@opengtm/verify";
import { runWrite } from "@opengtm/writer";
import { sql } from "drizzle-orm";
import { seedMailbox } from "../tests/fixtures";

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error("live-trial only runs against a localhost DATABASE_URL");
for (const k of ["OPENAI_API_KEY", "AI_ARK_API_KEY"]) if (!process.env[k]) throw new Error(`${k} is not set`);

const config = loadConfig();
const c = config.business;
if (!c.company.physical_address) c.company.physical_address = "[Your mailing address]";
if (!c.senders.some((s) => s.name)) c.senders = [{ name: "[Your name]", title: "[Your title]", reply_to: "" }];

const log = createLogger("trial", "warn");
const { db, close } = createDb(url);
const ctx: Ctx = {
  db,
  config,
  log,
  clock: systemClock,
  env: process.env,
  random: Math.random,
  alerts: new Alerter(db, [new ConsoleSink(log)], systemClock, log),
  llm: createLlm({ db, config, providers: providersFromEnv(config.llm, process.env), clock: systemClock, log }),
};

const a = config.engine.leads.ai_ark;
const ark = new AiArkSource({
  apiKey: process.env.AI_ARK_API_KEY!,
  termsAllowOutbound: true, // rehearsal only: nothing is sent
  maxCreditsPerRun: arg("credits", 30),
  maxExportsPerCompany: a.max_exports_per_company,
  pageSize: a.page_size,
  employeeMin: a.employee_min,
  employeeMax: a.employee_max,
  industries: a.industries,
  cursor: { get: async (k) => getSetting<number | null>(db, k, null), set: async (k, v) => setSetting(db, k, v, "trial") },
  onSpend: (credits, note) => recordSpend(db, "lead_data", credits * a.credit_usd, { ref: "ai_ark", note }),
});

const step = (s: string) => console.log(`\n== ${s}`);
const q = async (s: ReturnType<typeof sql>) => ((await db.execute(s)) as unknown as { rows: Record<string, unknown>[] }).rows;
await ensureDefaultCampaigns(ctx);
const [mbRow] = await q(sql`select count(*)::int as n from mailboxes`);
if (!mbRow?.n) {
  const mb = await seedMailbox(ctx, { email: "trial@fake-mailbox.example", domain: "fake-mailbox.example", provider: "microsoft" });
  await db.execute(sql`update mailboxes set sender_name = ${c.senders[0]!.name}, sender_title = ${c.senders[0]!.title} where id = ${mb.id}`);
}

step("Discover (AI Ark)");
console.log(await runDiscover(ctx, [ark], { limitPerSegment: arg("companies", 2) }), `credits used: ${ark.creditsUsed}`);
step("Qualify");
console.log(await runQualify(ctx));
step("Verify (real MX lookup; mailbox check mocked, no ZeroBounce key yet)");
console.log(await runVerify(ctx, { verifier: new MockVerifier(0), mx: new DnsMxResolver() }));
step("Research (real websites)");
const fetcher = new PoliteFetcher({ userAgent: config.engine.research.user_agent, delayMs: config.engine.research.request_delay_ms });
console.log(await runResearch(ctx, fetcher, 50));
step("Enroll and write (gpt-6-luna)");
console.log(await runEnroll(ctx, 50));
console.log(await runWrite(ctx, 50));

step("Summary");
console.table(await q(sql`select status, count(*)::int as companies from ${companies} group by status order by 1`));
console.table(await q(sql`select status, count(*)::int as contacts from ${contacts} group by status order by 1`));
console.table(await q(sql`select c.name, c.state, c.website, count(f.id)::int as facts from ${companies} c left join ${facts} f on f.company_id = c.id group by c.id order by 4 desc`));
console.table(await q(sql`select approval_state, count(*)::int as drafts from ${messages} group by 1`));
console.table(await q(sql`select task, count(*)::int as calls, round(sum(cost_usd)::numeric, 4) as usd, sum(case when ok then 0 else 1 end)::int as failed from ${llmCalls} group by task order by 1`));
console.log(`AI Ark credits used this run: ${ark.creditsUsed}`);
await close();
