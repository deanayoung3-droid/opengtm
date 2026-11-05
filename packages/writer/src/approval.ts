import {
  audit,
  getForceApproval,
  mailboxes,
  messages,
  threads,
  type ApprovalState,
  type Ctx,
} from "@opengtm/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { checkCompliance, stripFooter } from "./compliance";
import { checkStep, type Issue } from "./rules";

export interface ApprovalDecision {
  state: ApprovalState;
  reason: string;
  sampled?: boolean;
}

/**
 * Approval policy (section 8.6):
 * - global force switch (dashboard setting, else engine.yaml) -> human approval
 * - critic failed after regenerations -> needs_review
 * - critic score below threshold -> human approval
 * - fewer than N messages approved so far -> human approval
 * - otherwise auto-approve, holding a random sample for review
 */
export async function decideApproval(ctx: Ctx, opts: { passed: boolean; score: number }): Promise<ApprovalDecision> {
  const { approval, writer } = ctx.config.engine;
  if (!opts.passed) return { state: "needs_review", reason: "critic failed after regenerations" };
  const force = (await getForceApproval(ctx.db)) ?? approval.force_all;
  if (force) return { state: "pending", reason: "approval forced globally" };
  if (opts.score < writer.critic_threshold) return { state: "pending", reason: `critic score ${opts.score} < ${writer.critic_threshold}` };
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.kind, "sequence"), inArray(messages.approvalState, ["approved", "auto_approved"])));
  if ((row?.n ?? 0) < approval.require_first_n) return { state: "pending", reason: `first ${approval.require_first_n} messages need approval` };
  if (ctx.random() < approval.sample_rate) return { state: "pending", reason: "random sample for review", sampled: true };
  return { state: "auto_approved", reason: "auto-approved" };
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

/**
 * Human approval, optionally with edits. Edited copy is re-checked against the
 * hard rules and compliance, using the same facts the draft cited.
 */
export async function approveMessage(
  ctx: Ctx,
  messageId: string,
  actor: string,
  edit?: { subject?: string; body?: string },
): Promise<void> {
  const [m] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!m) throw new ApprovalError("message not found");
  if (m.status !== "draft") throw new ApprovalError(`message is ${m.status}, not a draft`);
  let body = m.body;
  let subject = m.subject;
  if (edit?.body !== undefined || edit?.subject !== undefined) {
    body = edit.body ?? m.body;
    subject = edit.subject ?? m.subject;
    const [t] = await ctx.db.select().from(threads).where(eq(threads.id, m.threadId));
    const [mb] = t?.mailboxId ? await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, t.mailboxId)) : [];
    const issues = checkCompliance(body, ctx.config, { name: mb?.senderName ?? "", title: mb?.senderTitle, phone: mb?.senderPhone });
    const { verdictFacts } = (m.qaVerdict ?? {}) as { verdictFacts?: Record<string, string> };
    const bodyOnly = stripFooter(body);
    issues.push(
      ...checkStep(
        { step: m.stepNumber, body: bodyOnly, fact_ids: m.factIds, proof_point_ids: m.proofPointIds },
        {
          facts: new Map(Object.entries(verdictFacts ?? {})),
          proofPoints: new Map(ctx.config.proofPoints.map((p) => [p.id, p.text])),
          bannedClaims: ctx.config.business.company.banned_claims,
          minWords: ctx.config.engine.writer.min_words,
          maxWords: ctx.config.engine.writer.max_words,
          bookingLink: ctx.config.business.company.booking_link,
        },
      ).filter((i) => i.code !== "word_count"), // humans may trim or extend slightly
    );
    if (issues.length) throw new ApprovalError("edited message fails checks", issues);
  }
  await ctx.db
    .update(messages)
    .set({ approvalState: "approved", approvedBy: actor, approvedAt: ctx.clock.now(), body, subject })
    .where(eq(messages.id, messageId));
  await audit(ctx.db, actor, edit ? "message.approve_edited" : "message.approve", "messages", messageId);
}

export async function rejectMessage(ctx: Ctx, messageId: string, actor: string, reason: string): Promise<void> {
  const [m] = await ctx.db
    .update(messages)
    .set({ approvalState: "rejected", status: "cancelled" })
    .where(and(eq(messages.id, messageId), eq(messages.status, "draft")))
    .returning();
  if (!m) throw new ApprovalError("message not found or not a draft");
  // A rejected sequence step ends the thread: later steps would read oddly without it.
  if (m.kind === "sequence") {
    await ctx.db.update(threads).set({ status: "stopped", stopReason: `rejected: ${reason}` }).where(eq(threads.id, m.threadId));
    await ctx.db
      .update(messages)
      .set({ status: "cancelled" })
      .where(and(eq(messages.threadId, m.threadId), eq(messages.status, "draft")));
  }
  await audit(ctx.db, actor, "message.reject", "messages", messageId, { reason });
}

export async function bulkApprove(ctx: Ctx, messageIds: string[], actor: string): Promise<{ approved: number; failed: string[] }> {
  let approved = 0;
  const failed: string[] = [];
  for (const id of messageIds) {
    try {
      await approveMessage(ctx, id, actor);
      approved++;
    } catch {
      failed.push(id);
    }
  }
  return { approved, failed };
}
