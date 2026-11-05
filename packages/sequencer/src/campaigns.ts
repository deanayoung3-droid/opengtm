import { audit, campaigns, getSetting, messages, segments, sequences, sequenceSteps, setSetting, threads, type Ctx } from "@opengtm/core";
import { and, eq, inArray, ne, notInArray } from "drizzle-orm";

const APPLIED = "sequence_config_applied";

/**
 * Default step instructions. The writer's prompt carries the whole structure, so these only point at it;
 * the versions differ in the first email's subject (version B tests outreach.subject_lines_b when set).
 */
export const DEFAULT_INSTRUCTIONS: Record<string, string[]> = {
  // A and B differ only in the first email's subject (B uses outreach.subject_lines_b); the prompt carries the rest.
  A: ["Follow the general rules for step 1.", "Follow the general rules for step 2.", "Follow the general rules for later steps.", "Follow the general rules for later steps."],
  B: ["Follow the general rules for step 1.", "Follow the general rules for step 2.", "Follow the general rules for later steps.", "Follow the general rules for later steps."],
};

/** Ensure the default sequence (variants A/B) and one campaign per segment exist. Idempotent. */
export async function ensureDefaultCampaigns(ctx: Ctx): Promise<void> {
  // Descriptions follow Project docs / business.yaml, so edits there reach the writer and the scorer.
  for (const s of ctx.config.business.icp.segments) {
    await ctx.db.insert(segments).values({ id: s.id, description: s.description }).onConflictDoUpdate({ target: segments.id, set: { description: s.description } });
  }
  let [seq] = await ctx.db.select().from(sequences).where(eq(sequences.name, "default"));
  if (!seq) {
    [seq] = await ctx.db.insert(sequences).values({ name: "default" }).returning();
    for (const [variant, instr] of Object.entries(DEFAULT_INSTRUCTIONS)) {
      await ctx.db.insert(sequenceSteps).values(
        ctx.config.engine.sequence.steps.map((s, i) => ({
          sequenceId: seq!.id,
          stepNumber: s.step,
          dayOffset: s.day,
          variant,
          instructions: instr[i] ?? "",
        })),
      );
    }
  }
  await applySequenceConfig(ctx, seq!.id);
  const existing = await ctx.db.select().from(campaigns);
  for (const s of ctx.config.business.icp.segments) {
    if (existing.some((c) => c.segmentId === s.id)) continue;
    await ctx.db.insert(campaigns).values({ name: `${s.id} - default`, segmentId: s.id, sequenceId: seq!.id });
  }
}

/**
 * When engine.yaml's sequence changes (e.g. 4 steps -> 2), bring the stored sequence in line
 * once: retire steps that are gone, add new ones, update days, cancel unsent drafts of retired steps, and
 * move unsent emails of kept steps to the new day (2026-11-01: the follow-up went from day 3 to day 7).
 * Runs only when the config changed, so later edits on the Email sequence page are kept.
 */
async function applySequenceConfig(ctx: Ctx, sequenceId: string): Promise<void> {
  const want = ctx.config.engine.sequence.steps;
  const key = want.map((s) => `${s.step}@${s.day}`).join(",");
  if ((await getSetting<{ steps?: string } | null>(ctx.db, APPLIED, null))?.steps === key) return;
  const rows = await ctx.db.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, sequenceId));
  const keep = want.map((s) => s.step);
  for (const variant of [...new Set(rows.map((r) => r.variant))]) {
    for (const [i, s] of want.entries()) {
      const row = rows.find((r) => r.variant === variant && r.stepNumber === s.step);
      if (row) await ctx.db.update(sequenceSteps).set({ dayOffset: s.day, status: row.status === "retired" ? "active" : row.status }).where(eq(sequenceSteps.id, row.id));
      else await ctx.db.insert(sequenceSteps).values({ sequenceId, stepNumber: s.step, dayOffset: s.day, variant, instructions: DEFAULT_INSTRUCTIONS[variant]?.[i] ?? "" });
    }
  }
  await ctx.db
    .update(sequenceSteps)
    .set({ status: "retired" })
    .where(and(eq(sequenceSteps.sequenceId, sequenceId), notInArray(sequenceSteps.stepNumber, keep)));
  // Emails already written for steps that no longer exist never go out.
  const seqThreads = ctx.db.select({ id: threads.id }).from(threads).innerJoin(campaigns, eq(campaigns.id, threads.campaignId)).where(eq(campaigns.sequenceId, sequenceId));
  const cancelled = await ctx.db
    .update(messages)
    .set({ status: "cancelled" })
    .where(and(eq(messages.kind, "sequence"), inArray(messages.status, ["draft", "scheduled"]), notInArray(messages.stepNumber, keep), inArray(messages.threadId, seqThreads)))
    .returning({ id: messages.id });
  // Emails already written but not sent take the new day; a scheduled one goes back to be planned again,
  // counting from when the first email went out.
  let moved = 0;
  for (const s of want) {
    const stale = and(eq(messages.kind, "sequence"), eq(messages.stepNumber, s.step), ne(messages.dayOffset, s.day), inArray(messages.threadId, seqThreads));
    moved += (await ctx.db.update(messages).set({ dayOffset: s.day }).where(and(stale, eq(messages.status, "draft"))).returning({ id: messages.id })).length;
    moved += (await ctx.db.update(messages).set({ dayOffset: s.day, status: "draft", scheduledFor: null }).where(and(stale, eq(messages.status, "scheduled"))).returning({ id: messages.id })).length;
  }
  await setSetting(ctx.db, APPLIED, { steps: key }, "config");
  await audit(ctx.db, "config", "sequence.apply_config", "sequences", sequenceId, { steps: want, cancelledDrafts: cancelled.length, movedToNewDay: moved });
}
