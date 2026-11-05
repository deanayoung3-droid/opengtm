import { companies, LlmExhaustedError, loadPrompt, NoRouteError, normalizeState, render, SpendCapError, type Config, type Ctx, brandVars } from "@opengtm/core";
import { eq } from "drizzle-orm";
import { syncSegments } from "./discover";
import { z } from "zod";

export interface IcpInput {
  name: string;
  domain: string;
  country: string;
  state: string | null;
  companySize: number | null;
  focusAreas: string[];
  segmentId: string | null;
  signals: string[];
}

export interface IcpScore {
  score: number;
  segmentId: string | null;
  reason: string;
  hardFail?: string;
}

export function matchSegment(config: Config, focusAreas: string[], name: string): string | null {
  const hay = `${focusAreas.join(" | ")} | ${name}`.toLowerCase();
  let best: { id: string; hits: number } | null = null;
  for (const seg of config.business.icp.segments) {
    const hits = seg.keywords.filter((k) => hay.includes(k.toLowerCase())).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { id: seg.id, hits };
  }
  return best?.id ?? null;
}

/**
 * Deterministic ICP fit, 0-100:
 *   geography 20 (US + known state), company size 30 (1-10 people),
 *   focus area 40 (matches a segment's keywords), signals 10.
 * Hard fails: non-US, more people than qualify.max_company_size (lead sources count all staff).
 */
export function scoreCompany(config: Config, c: IcpInput): IcpScore {
  const reasons: string[] = [];
  if (c.country !== "US") return { score: 0, segmentId: null, reason: "non-US", hardFail: "non_us" };
  if (c.companySize !== null && c.companySize > config.engine.qualify.max_company_size) {
    return { score: 0, segmentId: null, reason: `company too large (${c.companySize} people)`, hardFail: "too_large" };
  }
  let score = 0;
  if (normalizeState(c.state)) {
    score += 20;
    reasons.push(`US/${normalizeState(c.state)}`);
  } else {
    score += 10;
    reasons.push("US, state unknown");
  }
  if (c.companySize === null) {
    score += 15;
    reasons.push("size unknown");
  } else if (c.companySize <= 10) {
    score += 30;
    reasons.push(`${c.companySize} people`);
  } else {
    score += 10;
    reasons.push(`${c.companySize} people (above core ICP)`);
  }
  const segmentId = matchSegment(config, c.focusAreas, c.name) ?? null;
  if (segmentId) {
    score += 40;
    reasons.push(`keywords match ${segmentId}`);
  } else {
    reasons.push("no segment keywords matched");
  }
  if (c.signals.length) {
    score += 10;
    reasons.push(`signals: ${c.signals.join(", ")}`);
  }
  return { score: Math.min(100, score), segmentId, reason: reasons.join("; ") };
}

const TagSchema = z.object({
  segment_id: z.string().nullable(),
  focus_areas: z.array(z.string()).max(6),
  confidence: z.number().min(0).max(1),
});

/** Ask the cheap model to pick a segment when keywords found none. Returns null if unavailable. */
async function llmTag(ctx: Ctx, companyId: string, c: IcpInput): Promise<z.infer<typeof TagSchema> | null> {
  // Decision model first: picks a segment or "none" with calibrated confidence.
  try {
    const criteria: Record<string, string> = Object.fromEntries(ctx.config.business.icp.segments.map((s) => [s.id, s.description]));
    criteria.none = "None of these, or the information does not clearly indicate a segment";
    const d = await ctx.llm.decide(
      "lead_tagging",
      JSON.stringify({ name: c.name, domain: c.domain, state: c.state, focus_areas: c.focusAreas }),
      { segment: { type: "choice", instructions: "Which segment does this US company belong to? Do not guess from a person's name alone.", criteria } },
      { companyId },
    );
    const a = d.answers.segment;
    if (a?.type === "choice") return { segment_id: a.choice === "none" ? null : a.choice, focus_areas: [], confidence: a.confidence };
  } catch (err) {
    if (!(err instanceof SpendCapError || err instanceof LlmExhaustedError || err instanceof NoRouteError)) throw err;
  }
  const prompt = loadPrompt("lead_tagging");
  try {
    const res = await ctx.llm.run(
      "lead_tagging",
      {
        system: render(prompt.system, brandVars(ctx.config)),
        prompt: render(prompt.user, {
          segments: ctx.config.business.icp.segments.map((s) => `- ${s.id}: ${s.description}`).join("\n"),
          company: JSON.stringify({ name: c.name, domain: c.domain, state: c.state, focus_areas: c.focusAreas }),
        }),
        promptVersion: prompt.version,
      },
      TagSchema,
      { companyId, expectedOutputTokens: 200 },
    );
    const valid = new Set(ctx.config.business.icp.segments.map((s) => s.id));
    if (res.data.segment_id && !valid.has(res.data.segment_id)) return { ...res.data, segment_id: null };
    return res.data;
  } catch (err) {
    if (err instanceof SpendCapError || err instanceof LlmExhaustedError || err instanceof NoRouteError) return null;
    throw err;
  }
}

/** Qualify: score new companies; below threshold are dropped with a stored reason. */
export async function runQualify(ctx: Ctx, limit = 200): Promise<{ qualified: number; disqualified: number }> {
  await syncSegments(ctx); // companies can arrive by CSV import before any discover run
  const rows = await ctx.db.select().from(companies).where(eq(companies.status, "new")).limit(limit);
  let qualified = 0;
  let disqualified = 0;
  for (const row of rows) {
    const input: IcpInput = {
      name: row.name,
      domain: row.domain,
      country: row.country,
      state: row.state,
      companySize: row.companySize,
      focusAreas: row.focusAreas,
      segmentId: row.segmentId,
      signals: row.signals,
    };
    let result = scoreCompany(ctx.config, input);
    let focusAreas = row.focusAreas;
    if (!result.hardFail && !result.segmentId) {
      const tag = await llmTag(ctx, row.id, input);
      if (tag && tag.segment_id && tag.confidence >= 0.6) {
        focusAreas = [...new Set([...focusAreas, ...tag.focus_areas.map((p) => p.toLowerCase())])];
        result = scoreCompany(ctx.config, { ...input, focusAreas: [...focusAreas, ...tag.focus_areas] });
        if (!result.segmentId) result = { ...result, segmentId: tag.segment_id, score: result.score + 40, reason: `${result.reason}; tagged ${tag.segment_id} by model` };
      }
    }
    const ok = !result.hardFail && result.score >= ctx.config.engine.qualify.threshold;
    await ctx.db
      .update(companies)
      .set({
        status: ok ? "qualified" : "disqualified",
        icpScore: result.score,
        icpReason: ok ? result.reason : `below threshold: ${result.reason}`,
        segmentId: result.segmentId ?? row.segmentId,
        focusAreas,
        updatedAt: ctx.clock.now(),
      })
      .where(eq(companies.id, row.id));
    if (ok) qualified++;
    else disqualified++;
  }
  return { qualified, disqualified };
}
