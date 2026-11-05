import { DAY, events, LlmExhaustedError, loadPrompt, mailboxes, NoRouteError, recordEvent, render, SpendCapError, spendLedger, type Ctx, brandVars } from "@opengtm/core";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { costPerMeeting, segmentFunnel, sendsSince, stepVariantStats, type FunnelRow } from "./metrics";

const InsightSchema = z.object({
  headline: z.string(),
  top_segments: z.array(z.string()).max(3),
  worst_segments: z.array(z.string()).max(3),
  actions: z.array(z.string()).max(6),
});

const usd = (x: number | null) => (x === null ? "-" : `$${x.toFixed(2)}`);

function funnelTable(rows: FunnelRow[]): string {
  const head = "| Segment | Status | Sourced | Verified | Emailed | Replied | Positive | Booked | Cost | $/positive | $/meeting |\n|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows
    .map((r) => `| ${r.segmentId} | ${r.status} | ${r.sourced} | ${r.verified} | ${r.emailed} | ${r.replied} | ${r.positive} | ${r.booked} | ${usd(r.costUsd)} | ${usd(r.costPerPositive)} | ${usd(r.costPerMeeting)} |`)
    .join("\n");
  return `${head}\n${body}`;
}

/** Weekly "what to do next" digest from real data; the model only adds the recommendations. */
export async function buildWeeklyDigest(ctx: Ctx): Promise<{ subject: string; markdown: string }> {
  const now = ctx.clock.now();
  const since = new Date(now.getTime() - 7 * DAY);
  const [week, allTime, variants, cpm, sends] = await Promise.all([
    segmentFunnel(ctx, since),
    segmentFunnel(ctx),
    stepVariantStats(ctx, since),
    costPerMeeting(ctx, since),
    sendsSince(ctx, since),
  ]);
  const mbs = await ctx.db.select().from(mailboxes);
  const spendByCat = await ctx.db
    .select({ cat: spendLedger.category, usd: sql<number>`coalesce(sum(${spendLedger.amountUsd}),0)::float8` })
    .from(spendLedger)
    .where(gte(spendLedger.createdAt, since))
    .groupBy(spendLedger.category);
  const alerts = await ctx.db.select().from(events).where(and(eq(events.type, "alert"), gte(events.createdAt, since))).orderBy(desc(events.createdAt)).limit(20);

  const facts = {
    period: `${since.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`,
    sends,
    week: week.map(({ segmentId, status, emailed, replied, positive, booked, costUsd, positiveRate }) => ({ segmentId, status, emailed, replied, positive, booked, costUsd: +costUsd.toFixed(2), positiveRate: +positiveRate.toFixed(3) })),
    allTime: allTime.map(({ segmentId, emailed, positive, booked }) => ({ segmentId, emailed, positive, booked })),
    variants,
    mailboxes: mbs.map((m) => ({ email: m.email, status: m.status, health: m.healthScore, reason: m.pausedReason })),
    spend: Object.fromEntries(spendByCat.map((s) => [s.cat, +Number(s.usd).toFixed(2)])),
    costPerMeeting: cpm,
    alerts: alerts.map((a) => (a.data as { title?: string }).title).filter(Boolean),
  };

  let insight: z.infer<typeof InsightSchema> | null = null;
  try {
    const prompt = loadPrompt("weekly_digest");
    const res = await ctx.llm.run("segment_insights", { system: render(prompt.system, brandVars(ctx.config)), prompt: render(prompt.user, { data: JSON.stringify(facts, null, 2) }), promptVersion: prompt.version }, InsightSchema, { expectedOutputTokens: 1500 });
    insight = res.data;
  } catch (err) {
    if (!(err instanceof SpendCapError || err instanceof LlmExhaustedError || err instanceof NoRouteError)) throw err;
  }

  const lines = [
    `# ${ctx.config.business.company.name} outbound: week of ${facts.period}`,
    "",
    insight ? `**${insight.headline}**` : "_Recommendations unavailable (no model reachable); numbers below are complete._",
    "",
    `Sends: ${sends}  |  Spend: ${usd(cpm.spend)}  |  Meetings booked: ${cpm.meetings}  |  Cost per meeting: ${usd(cpm.costPerMeeting)}`,
    "",
    "## Funnel this week",
    funnelTable(week),
    "",
    "## Variants this week (segment / step / variant: sends, replies, positive)",
    ...(variants.length ? variants.map((v) => `- ${v.segmentId} / ${v.step} / ${v.variant}: ${v.sends}, ${v.replies}, ${v.positive}`) : ["- no sends"]),
    "",
    "## Mailbox health",
    ...mbs.map((m) => `- ${m.email}: ${m.status}, health ${m.healthScore}${m.pausedReason ? ` (${m.pausedReason})` : ""}`),
    "",
    "## Spend by category",
    ...(spendByCat.length ? spendByCat.map((s) => `- ${s.cat}: ${usd(Number(s.usd))}`) : ["- none"]),
  ];
  if (insight) {
    lines.push("", "## Best segments", ...insight.top_segments.map((s) => `- ${s}`), "", "## Worst segments", ...insight.worst_segments.map((s) => `- ${s}`), "", "## Recommended actions", ...insight.actions.map((a) => `- ${a}`));
  }
  if (facts.alerts.length) lines.push("", "## Alerts this week", ...facts.alerts.map((a) => `- ${a}`));
  return { subject: `${ctx.config.business.company.name} outbound weekly: ${cpm.meetings} meetings, ${usd(cpm.costPerMeeting)}/meeting`, markdown: lines.join("\n") };
}

export async function runWeeklyDigest(ctx: Ctx, send: (subject: string, text: string) => Promise<unknown>): Promise<string> {
  const d = await buildWeeklyDigest(ctx);
  await recordEvent(ctx.db, "digest", { data: { subject: d.subject, markdown: d.markdown }, at: ctx.clock.now() });
  try {
    await send(d.subject, d.markdown);
  } catch (err) {
    ctx.log.error({ err }, "digest email failed; it is still visible on the dashboard");
  }
  return d.markdown;
}
