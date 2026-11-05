import { audit, LlmExhaustedError, loadPrompt, messages, NoRouteError, render, replies, sequences, sequenceSteps, SpendCapError, threads, type Ctx, brandVars } from "@opengtm/core";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { POSITIVE_LABELS } from "./metrics";

/** Standard normal CDF (Abramowitz-Stegun erf approximation, |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-((x / Math.SQRT2) ** 2));
  return 0.5 * (1 + Math.sign(x) * y);
}

/** Two-sided two-proportion z-test. */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number): { z: number; p: number } {
  if (!n1 || !n2) return { z: 0, p: 1 };
  const pool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (x1 / n1 - x2 / n2) / se;
  return { z, p: 2 * (1 - normCdf(Math.abs(z))) };
}

export interface VariantStat {
  variant: string;
  threads: number;
  positive: number;
  rate: number;
}

/** Threads whose step 1 went out, and how many of them produced a positive reply, per variant. */
export async function variantStats(ctx: Ctx, sequenceId: string): Promise<VariantStat[]> {
  const started = await ctx.db
    .select({ threadId: messages.threadId, variant: messages.variant })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(sequenceSteps, and(eq(sequenceSteps.sequenceId, sequenceId), eq(sequenceSteps.stepNumber, 1), eq(sequenceSteps.variant, messages.variant)))
    .where(and(eq(messages.status, "sent"), eq(messages.stepNumber, 1), eq(messages.kind, "sequence")));
  const positiveThreads = new Set(
    (
      await ctx.db
        .select({ threadId: replies.threadId })
        .from(replies)
        .where(and(isNotNull(replies.threadId), inArray(replies.label, POSITIVE_LABELS)))
    ).map((r) => r.threadId),
  );
  const by = new Map<string, VariantStat>();
  for (const s of started) {
    const v = by.get(s.variant) ?? { variant: s.variant, threads: 0, positive: 0, rate: 0 };
    v.threads++;
    if (positiveThreads.has(s.threadId)) v.positive++;
    by.set(s.variant, v);
  }
  for (const v of by.values()) v.rate = v.threads ? v.positive / v.threads : 0;
  return [...by.values()].sort((a, b) => a.variant.localeCompare(b.variant));
}

const ChallengerSchema = z.object({
  rationale: z.string(),
  steps: z.array(z.object({ step: z.number().int(), instructions: z.string() })),
});

function nextLetter(used: string[]): string {
  for (let c = 65; c < 91; c++) if (!used.includes(String.fromCharCode(c))) return String.fromCharCode(c);
  return `V${used.length + 1}`;
}

/** Ask the model for a challenger variant built from what won and lost. Stored as "proposed" until a human activates it. */
export async function proposeChallenger(ctx: Ctx, sequenceId: string, winner: string, loser: string | null): Promise<string | null> {
  const steps = await ctx.db.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, sequenceId)).orderBy(asc(sequenceSteps.stepNumber));
  if (steps.some((s) => s.status === "proposed")) return null; // one open proposal at a time
  const sample = async (variant: string, positive: boolean) =>
    (
      await ctx.db
        .select({ body: replies.body, label: replies.label })
        .from(replies)
        .innerJoin(messages, eq(messages.id, replies.messageId))
        .where(and(eq(messages.variant, variant), isNotNull(replies.label)))
        .limit(40)
    )
      .filter((r) => POSITIVE_LABELS.includes(r.label!) === positive)
      .slice(0, 8)
      .map((r) => `- (${r.label}) ${r.body.slice(0, 240).replace(/\s+/g, " ")}`)
      .join("\n") || "(none)";

  const prompt = loadPrompt("variant_challenger");
  try {
    const res = await ctx.llm.run(
      "segment_insights",
      {
        system: render(prompt.system, brandVars(ctx.config)),
        prompt: render(prompt.user, {
          winner_steps: steps.filter((s) => s.variant === winner).map((s) => `Step ${s.stepNumber}: ${s.instructions}`).join("\n"),
          loser_steps: loser ? steps.filter((s) => s.variant === loser).map((s) => `Step ${s.stepNumber}: ${s.instructions}`).join("\n") : "(none)",
          winning_replies: await sample(winner, true),
          losing_replies: loser ? await sample(loser, false) : "(none)",
        }),
        promptVersion: prompt.version,
      },
      ChallengerSchema,
      { expectedOutputTokens: 1500 },
    );
    const letter = nextLetter([...new Set(steps.map((s) => s.variant))]);
    const days = new Map(steps.filter((s) => s.variant === winner).map((s) => [s.stepNumber, s.dayOffset]));
    const rows = res.data.steps.filter((s) => days.has(s.step));
    if (rows.length !== days.size) return null;
    await ctx.db.insert(sequenceSteps).values(rows.map((s) => ({ sequenceId, stepNumber: s.step, dayOffset: days.get(s.step)!, variant: letter, instructions: s.instructions, status: "proposed" as const })));
    await ctx.alerts.notify({ level: "info", key: `variant_proposed:${sequenceId}:${letter}`, title: `New challenger variant ${letter} proposed`, body: `${res.data.rationale}\n\nReview and activate it on the Campaigns screen.` });
    return letter;
  } catch (err) {
    if (err instanceof SpendCapError || err instanceof LlmExhaustedError || err instanceof NoRouteError) return null;
    throw err;
  }
}

export interface VariantDecision {
  sequenceId: string;
  stats: VariantStat[];
  winner?: string;
  loser?: string;
  p?: number;
  proposed?: string | null;
}

/**
 * Keep two variants live. When both have enough threads and the difference in
 * positive-reply rate is significant, retire the loser and propose a challenger.
 */
export async function runVariantTests(ctx: Ctx): Promise<VariantDecision[]> {
  const l = ctx.config.engine.learning;
  const out: VariantDecision[] = [];
  for (const seq of await ctx.db.select().from(sequences)) {
    const active = [...new Set((await ctx.db.select({ v: sequenceSteps.variant }).from(sequenceSteps).where(and(eq(sequenceSteps.sequenceId, seq.id), eq(sequenceSteps.status, "active")))).map((r) => r.v))];
    const stats = (await variantStats(ctx, seq.id)).filter((s) => active.includes(s.variant));
    const d: VariantDecision = { sequenceId: seq.id, stats };
    if (active.length === 1) {
      d.proposed = await proposeChallenger(ctx, seq.id, active[0]!, null);
    } else if (stats.length >= 2) {
      const [a, b] = [...stats].sort((x, y) => y.threads - x.threads);
      if (a!.threads >= l.min_sends_per_variant && b!.threads >= l.min_sends_per_variant) {
        const { p } = twoProportionTest(a!.positive, a!.threads, b!.positive, b!.threads);
        d.p = p;
        if (p < l.significance) {
          const [win, lose] = a!.rate >= b!.rate ? [a!, b!] : [b!, a!];
          d.winner = win.variant;
          d.loser = lose.variant;
          await ctx.db.update(sequenceSteps).set({ status: "retired" }).where(and(eq(sequenceSteps.sequenceId, seq.id), eq(sequenceSteps.variant, lose.variant)));
          await audit(ctx.db, "learning", "variant.retire", "sequences", seq.id, { winner: win.variant, loser: lose.variant, p });
          d.proposed = await proposeChallenger(ctx, seq.id, win.variant, lose.variant);
        }
      }
    }
    out.push(d);
  }
  return out;
}

export async function activateVariant(ctx: Ctx, sequenceId: string, variant: string, actor: string): Promise<void> {
  await ctx.db.update(sequenceSteps).set({ status: "active" }).where(and(eq(sequenceSteps.sequenceId, sequenceId), eq(sequenceSteps.variant, variant), eq(sequenceSteps.status, "proposed")));
  await audit(ctx.db, actor, "variant.activate", "sequences", sequenceId, { variant });
}

export async function rejectVariant(ctx: Ctx, sequenceId: string, variant: string, actor: string): Promise<void> {
  await ctx.db.update(sequenceSteps).set({ status: "retired" }).where(and(eq(sequenceSteps.sequenceId, sequenceId), eq(sequenceSteps.variant, variant), eq(sequenceSteps.status, "proposed")));
  await audit(ctx.db, actor, "variant.reject", "sequences", sequenceId, { variant });
}
