import { runHealthCheck, runSeedCheck, runSeedSend } from "@opengtm/health";
import { runSegmentGuards, runVariantTests, runWeeklyDigest } from "@opengtm/learning";
import { resolve4 } from "node:dns/promises";
import { teamDay, billingCycleStart, dailySpend, DAY, getSetting, recordSpend, refSpendSince, segments, setSetting } from "@opengtm/core";
import { eq } from "drizzle-orm";
import { AiArkSource, CompanySiteContactsSource, knownCompanyCheck, MockVendorSource, runDiscover, runQualify, type LeadSource } from "@opengtm/leads";
import { runAutoReplies, runReplies } from "@opengtm/replies";
import { runResearch } from "@opengtm/research";
import { ensureDefaultCampaigns, giveUniqueNames, leadStock, retryFailedLogins, runEnroll, runIngest, runSchedule, runSendTick } from "@opengtm/sequencer";
import { runVerify } from "@opengtm/verify";
import { recheckHeld, recheckSettingsBlocked, redraftHeld, refreshFollowups, runWrite } from "@opengtm/writer";
import type { Runtime } from "./context";

export interface JobDef {
  /** Cron in the team time zone (TEAM_TIMEZONE, Pacific by default). */
  cron: string;
  run: () => Promise<unknown>;
  /** How long one run may take before the queue gives up on it (pg-boss default: 15 minutes). */
  expireInSeconds?: number;
}

/**
 * When each job runs (cron in team time) and what it does, in the words the Schedule page shows.
 * "send" only sends inside each recipient's business hours, whatever the cron says.
 */
export const JOB_PLAN = {
  discover: { cron: "0 6 * * 1-5", label: "Find new companies and people", detail: "Searches the lead database for each campaign and adds new companies" },
  qualify: { cron: "*/5 * * * *", label: "Score fit", detail: "Scores each new company against its campaign; poor fits are dropped" },
  verify: { cron: "*/10 * * * *", label: "Check email addresses", detail: "Skips opted-out, bounced and already-contacted addresses" },
  research: { cron: "*/5 * * * *", label: "Research companies", detail: "Reads each company's website for facts to mention" },
  enroll: { cron: "*/15 * * * *", label: "Start sequences", detail: "Puts researched people into their campaign's sequence" },
  write: { cron: "*/5 * * * *", label: "Write emails", detail: "Writes and checks each email; a flagged sequence is rewritten once, and only odd ones wait on Approvals" },
  schedule: { cron: "* * * * *", label: "Plan send times", detail: "Puts each approved email in the recipient's next business-hours slot" },
  send: { cron: "* * * * *", label: "Send emails", detail: "Sends what is due, 30 seconds to 5 minutes apart per mailbox" },
  ingest: { cron: "*/3 * * * *", label: "Read replies", detail: "Checks every mailbox for replies and bounces" },
  replies: { cron: "*/3 * * * *", label: "Sort replies", detail: "Labels each reply, drafts an answer, flags hot leads" },
  "auto-reply": { cron: "*/2 * * * *", label: "Send reviewed replies", detail: "Sends drafted replies once their review window is over" },
  logins: { cron: "7 * * * *", label: "Inbox logins and names", detail: "Tries imported inboxes whose login failed again (switching each on once Google accepts it), and gives every new inbox its own full name" },
  health: { cron: "*/15 * * * *", label: "Mailbox health", detail: "Pauses a mailbox or domain on bounces or complaints" },
  "seed-send": { cron: "0 10 * * 1-5", label: "Inbox placement test", detail: "Sends test emails to our own seed inboxes (when set up)" },
  "seed-check": { cron: "*/20 * * * *", label: "Check placement tests", detail: "Looks whether test emails landed in the inbox or spam" },
  learning: { cron: "0 7 * * 1", label: "Weekly learning", detail: "Pauses campaigns that get no interest, picks winning email versions" },
  digest: { cron: "0 8 * * 1", label: "Weekly report email", detail: "What worked, what didn't, and what to do next" },
} satisfies Record<string, { cron: string; label: string; detail: string }>;

/** New companies needed: what the mailboxes can email in the next stock_days, minus companies already waiting (free new-company leads count too). */
async function leadShortfall(ctx: Runtime["ctx"]): Promise<{ perDay: number; waiting: number; short: number }> {
  const { perDay, waiting } = await leadStock(ctx);
  return { perDay, waiting, short: Math.max(0, Math.ceil(perDay * ctx.config.engine.leads.ai_ark.stock_days) - waiting) };
}

/** Lead sources enabled by env. AI Ark needs its key plus AI_ARK_TERMS_OK=1 after reading its terms. */
export async function leadSources(rt: Runtime): Promise<LeadSource[]> {
  const { ctx } = rt;
  const sources: LeadSource[] = [];
  if (rt.dryRun) sources.push(new MockVendorSource(25));
  const key = ctx.env.AI_ARK_API_KEY;
  if (key && !rt.dryRun) {
    const a = ctx.config.engine.leads.ai_ark;
    // Never let a discover run push the day past the spend cap, or the month past its credit budget.
    const now = ctx.clock.now();
    const room = ctx.config.engine.caps.daily_spend_cap_usd - (await dailySpend(ctx.db, now));
    const affordable = a.credit_usd > 0 ? Math.floor(room / a.credit_usd) : a.max_credits_per_run;
    const cycleStart = billingCycleStart(now, a.renews_on_day);
    const usedThisMonth = a.credit_usd > 0 ? (await refSpendSince(ctx.db, "ai_ark", cycleStart)) / a.credit_usd : 0;
    const monthLeft = Math.floor(a.max_credits_per_month - usedThisMonth + 1e-6);
    // Buy only what the mailboxes can email in the next few days, minus companies already waiting (free new-company
    // leads count too), so credits aren't spent on leads that go stale while mailboxes are paused or ramping.
    const { perDay, waiting, short } = await leadShortfall(ctx);
    const paced = Math.ceil(short * a.credits_per_person);
    ctx.log.info({ perDay, waiting, short, credits: paced }, "ai ark pacing");
    sources.push(
      new AiArkSource({
        apiKey: key,
        termsAllowOutbound: ctx.env.AI_ARK_TERMS_OK === "1",
        maxCreditsPerRun: Math.max(0, Math.min(a.max_credits_per_run, affordable, monthLeft, paced)),
        maxExportsPerCompany: a.max_exports_per_company,
        pageSize: a.page_size,
        employeeMin: a.employee_min,
        employeeMax: a.employee_max,
        industries: a.industries,
        extraTitles: a.extra_titles,
        searchVersion: a.search_version,
        // People Preview + one email lookup per new company, skipping companies we know (see AiArkOptions.preview).
        preview: a.preview,
        knownCompany: a.preview ? await knownCompanyCheck(ctx.db) : undefined,
        cursor: {
          get: async (k) => getSetting<number | null>(ctx.db, k, null),
          set: async (k, v) => setSetting(ctx.db, k, v, "ai_ark"),
        },
        onSpend: (credits, note) => recordSpend(ctx.db, "lead_data", credits * a.credit_usd, { ref: "ai_ark", note, at: ctx.clock.now() }),
      }),
    );
  }
  if (ctx.env.GTM_COMPANY_SITE_SOURCE_OK === "1") sources.push(new CompanySiteContactsSource(rt.fetcher, true));
  return sources;
}

export function buildJobs(rt: Runtime): Record<string, JobDef> {
  const { ctx } = rt;
  const sendDeps = { transportFor: rt.transportFor, publicBaseUrl: rt.publicBaseUrl, unsubscribeSecret: rt.unsubscribeSecret };
  const alertTo = (ctx.env.ALERT_EMAIL_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    discover: {
      cron: JOB_PLAN.discover.cron,
      // Hundreds of paid email lookups at AI Ark's rate limit can take longer than the default 15 minutes.
      expireInSeconds: 3600,
      run: async () => {
        const sources = await leadSources(rt);
        const ark = sources.find((s): s is AiArkSource => s instanceof AiArkSource);
        const cap = ctx.config.engine.leads.companies_per_segment_per_run;
        let limitPerSegment = cap;
        if (ark) {
          // Each active campaign gets an even share of what the mailboxes need, plus a fifth for campaigns that
          // run dry and companies the fit check drops; the credit budget above still caps what is bought.
          const { short } = await leadShortfall(ctx);
          const paused = new Set((await ctx.db.select({ id: segments.id }).from(segments).where(eq(segments.status, "paused"))).map((r) => r.id));
          const active = ctx.config.business.icp.segments.filter((s) => !paused.has(s.id)).length;
          limitPerSegment = Math.min(cap, Math.ceil((short * 1.2) / Math.max(1, active)));
        }
        const stats = await runDiscover(ctx, sources, { limitPerSegment });
        // How the credits went: paid lookups vs companies skipped for free.
        if (ark) ctx.log.info({ credits: ark.creditsUsed, skippedKnownCompanies: ark.skippedKnown, lookupsWithoutEmail: ark.notFound, failures: ark.failures.length }, "ai ark credits");
        return stats;
      },
    },
    qualify: { cron: JOB_PLAN.qualify.cron, run: () => runQualify(ctx, 200) },
    verify: {
      cron: JOB_PLAN.verify.cron,
      run: async () => {
        if (!rt.verifier) ctx.log.debug("no ZEROBOUNCE_API_KEY: only trusted sources (verify.trust_sources) are verified");
        return runVerify(ctx, { verifier: rt.verifier, mx: rt.mx }, 100);
      },
    },
    research: { cron: JOB_PLAN.research.cron, run: () => runResearch(ctx, rt.fetcher, 30) },
    enroll: {
      cron: JOB_PLAN.enroll.cron,
      run: async () => {
        await ensureDefaultCampaigns(ctx);
        return runEnroll(ctx, 50);
      },
    },
    write: {
      cron: JOB_PLAN.write.cron,
      run: async () => {
        // Step instructions first, so nothing is written under a step's old default after a deploy.
        await ensureDefaultCampaigns(ctx);
        return { recheck: await recheckSettingsBlocked(ctx), held: await recheckHeld(ctx), rewritten: await redraftHeld(ctx), followups: await refreshFollowups(ctx, 30), written: await runWrite(ctx, 30) };
      },
    },
    schedule: { cron: JOB_PLAN.schedule.cron, run: () => runSchedule(ctx) },
    send: { cron: JOB_PLAN.send.cron, run: () => runSendTick(ctx, sendDeps) },
    ingest: { cron: JOB_PLAN.ingest.cron, run: () => runIngest(ctx, rt.readerFor) },
    replies: { cron: JOB_PLAN.replies.cron, run: () => runReplies(ctx, { crm: rt.crm }) },
    "auto-reply": {
      cron: JOB_PLAN["auto-reply"].cron,
      run: () => runAutoReplies(ctx, { transportFor: rt.transportFor, publicBaseUrl: rt.publicBaseUrl, unsubscribeSecret: rt.unsubscribeSecret }),
    },
    logins: {
      cron: JOB_PLAN.logins.cron,
      run: async () => ({ names: await giveUniqueNames(ctx), logins: rt.dryRun ? { skipped: "dry run" } : await retryFailedLogins(ctx) }),
    },
    health: { cron: JOB_PLAN.health.cron, run: () => runHealthCheck(ctx) },
    "seed-send": { cron: JOB_PLAN["seed-send"].cron, run: () => runSeedSend(ctx, rt.transportFor) },
    "seed-check": { cron: JOB_PLAN["seed-check"].cron, run: () => runSeedCheck(ctx, rt.seedChecker) },
    learning: {
      cron: JOB_PLAN.learning.cron,
      run: async () => ({ guards: await runSegmentGuards(ctx), variants: await runVariantTests(ctx) }),
    },
    digest: { cron: JOB_PLAN.digest.cron, run: () => runWeeklyDigest(ctx, (subject, text) => rt.sendMail(alertTo, subject, text)) },
  };
}
