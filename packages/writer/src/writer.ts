import {
  audit,
  campaigns,
  companies,
  contacts,
  facts,
  LlmExhaustedError,
  loadPrompt,
  mailboxes,
  messages,
  NoRouteError,
  render,
  segments,
  sequenceSteps,
  SpendCapError,
  threads,
  type Ctx,
} from "@opengtm/core";
import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { decideApproval } from "./approval";
import { checkCompliance, composeBody, stripFooter, type SenderIdentity } from "./compliance";
import { checkStep, checkSubject, tidyBody, type Issue, type RuleContext } from "./rules";

type Prompt = ReturnType<typeof loadPrompt>;

export const SequenceDraftSchema = z.object({
  subject: z.string().describe("Subject for step 1; follow-ups reply in the same thread"),
  steps: z.array(
    z.object({
      step: z.number().int(),
      body: z.string().describe("Plain-text body without greeting sign-off or footer; the signature is added automatically"),
      fact_ids: z.array(z.string()).describe("Ids of every company fact this step relies on"),
      proof_point_ids: z.array(z.string()).describe("Ids of every proof point this step relies on"),
    }),
  ),
});
export type SequenceDraft = z.infer<typeof SequenceDraftSchema>;

export const CriticSchema = z.object({
  score: z.number().int().min(0).max(100),
  problems: z.array(
    z.object({
      step: z.number().int(),
      kind: z.enum(["unsupported_claim", "deceptive", "fake_familiarity", "pushy", "unclear", "other"]),
      text: z.string(),
    }),
  ),
});

export interface WriteOutcome {
  threadId: string;
  status: "drafted" | "needs_review" | "skipped" | "stopped";
  attempts: number;
  issues: Issue[];
  reason?: string;
}

interface StepPlan {
  step: number;
  day: number;
  instructions: string;
}

const BLOCKING_CRITIC = new Set(["unsupported_claim", "deceptive", "fake_familiarity"]);

/** Everything the writer needs for one thread: who it's to, what we know, the steps, the prompt. */
interface WriteSetup {
  contact: typeof contacts.$inferSelect;
  company: typeof companies.$inferSelect;
  plan: StepPlan[];
  companyFacts: (typeof facts.$inferSelect)[];
  factAlias: Map<string, typeof facts.$inferSelect>;
  personalize: boolean;
  proofPoints: Map<string, string>;
  ruleCtx: RuleContext;
  sender: SenderIdentity;
  prompt: Prompt;
  promptVars: Record<string, string | number>;
  /** Version B's set subject for this thread, used as written; null lets the writer name the company's work. */
  fixedSubject: string | null;
}

/** Returns why the thread can't be written instead, when something it needs is missing. */
async function setupWrite(ctx: Ctx, t: typeof threads.$inferSelect): Promise<WriteSetup | string> {
  const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, t.contactId));
  const [company] = await ctx.db.select().from(companies).where(eq(companies.id, t.companyId));
  const [campaign] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, t.campaignId));
  const [mailbox] = t.mailboxId ? await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, t.mailboxId)) : [];
  if (!contact || !company || !campaign || !mailbox) return "missing contact/company/campaign/mailbox";
  const [segment] = await ctx.db.select().from(segments).where(eq(segments.id, campaign.segmentId));
  const companyFacts = await ctx.db.select().from(facts).where(eq(facts.companyId, company.id)).orderBy(asc(facts.createdAt));
  const stepRows = await ctx.db
    .select()
    .from(sequenceSteps)
    .where(and(eq(sequenceSteps.sequenceId, campaign.sequenceId), eq(sequenceSteps.variant, t.variant), eq(sequenceSteps.status, "active")))
    .orderBy(asc(sequenceSteps.stepNumber));
  const plan: StepPlan[] = stepRows.length
    ? stepRows.map((s) => ({ step: s.stepNumber, day: s.dayOffset, instructions: s.instructions }))
    : ctx.config.engine.sequence.steps.map((s) => ({ step: s.step, day: s.day, instructions: "" }));

  // Short aliases are easier for models than UUIDs; map back after.
  const factAlias = new Map(companyFacts.map((f, i) => [`f${i + 1}`, f]));
  const personalize = companyFacts.length >= Math.max(1, ctx.config.engine.research.min_facts_for_personalization);
  const proofPoints = new Map(ctx.config.proofPoints.map((p) => [p.id, p.text]));
  const ruleCtx: RuleContext = {
    facts: new Map([...factAlias].map(([alias, f]) => [alias, f.text])),
    proofPoints,
    bannedClaims: ctx.config.business.company.banned_claims,
    minWords: ctx.config.engine.writer.min_words,
    followupMinWords: ctx.config.engine.writer.followup_min_words,
    maxWords: ctx.config.engine.writer.max_words + ctx.config.engine.writer.word_slack,
    bookingLink: ctx.config.business.company.booking_link,
    siteHost: siteHostOf(ctx.config.business.company.site),
  };
  const sender = { name: mailbox.senderName, title: mailbox.senderTitle, phone: mailbox.senderPhone };
  const c = ctx.config.business.company;

  const prompt = loadPrompt("write_email");
  const fixedSubject = t.variant === "B" ? pickSubject(ctx.config.business.outreach.subject_lines_b, t.id) : null;
  const promptVars = {
    subject_rule: fixedSubject
      ? `The step 1 subject is exactly "${fixedSubject}" (lowercase, as written). Follow-ups reply in the same thread.`
      : `The step 1 subject is two or three words naming the work their company does, in sentence case, like a colleague's email: "Closing files", "Fleet repairs", "Payroll runs", "Kitchen remodels". Never pitch ${c.name} in the subject, no "Re:", no punctuation. Follow-ups reply in the same thread.`,
    company_name: c.name,
    cta_reply: ctx.config.business.outreach.cta_reply,
    one_liner: c.one_liner,
    thesis: c.thesis,
    strengths: c.strengths.join(", "),
    proof_points: ctx.config.proofPoints.length ? ctx.config.proofPoints.map((p) => `[${p.id}] ${p.text}`).join("\n") : `(none yet; make no specific claims about ${c.name})`,
    banned: c.banned_claims.length ? c.banned_claims.join("; ") : "(none listed)",
    booking_link: c.booking_link || "(none; do not include a link)",
    offer: c.offer || "(none set: ask a simple question instead)",
    pricing: c.pricing || "(not given; say nothing about price)",
    competitors: ctx.config.business.competitors.length ? ctx.config.business.competitors.join(", ") : "(none listed)",
    instructions: ctx.config.business.outreach.instructions || "(none)",
    sender_first: sender.name.split(/\s+/)[0] ?? sender.name,
    segment: segment?.description ?? campaign.segmentId,
    recipient: recipientJson(contact, company),
    facts: personalize ? [...factAlias].map(([alias, f]) => `[${alias}] ${f.text} (source: ${f.sourceUrl})`).join("\n") : "(no researched facts: write segment-level copy, cite no fact ids, and do not pretend to know anything specific about this company)",
    signals: company.signals.length ? company.signals.join(", ") : "(none)",
    steps: stepsText(plan),
    min_words: ctx.config.engine.writer.min_words,
    followup_min_words: ctx.config.engine.writer.followup_min_words,
    max_words: ctx.config.engine.writer.max_words,
    sender_name: sender.name,
  };
  return { contact, company, plan, companyFacts, factAlias, personalize, proofPoints, ruleCtx, sender, prompt, promptVars, fixedSubject };
}

/** Version B tests set subjects: each thread gets one, the same one every time it's written (so rewrites keep it). */
function pickSubject(lines: string[], threadId: string): string | null {
  if (!lines.length) return null;
  let h = 0;
  for (const ch of threadId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return lines[h % lines.length]!;
}

const stepsText = (plan: StepPlan[]) => plan.map((p) => `Step ${p.step} (day ${p.day}): ${p.instructions || "follow the general rules"}`).join("\n");

interface Drafted {
  draft: SequenceDraft | null;
  issues: Issue[];
  criticScore: number;
  criticRan: boolean;
  cost: number;
  model: string;
  attempts: number;
  /** A spend cap or no model: nothing more can be written right now. */
  stopped?: Error;
}

/** Write the steps in `plan`, check them (and the subject when asked), and regenerate with the reasons until they pass. */
async function draftChecked(ctx: Ctx, w: WriteSetup, plan: StepPlan[], userPrompt: string, opts: { subject: boolean }): Promise<Drafted> {
  const out: Drafted = { draft: null, issues: [], criticScore: 0, criticRan: false, cost: 0, model: "", attempts: 0 };
  let feedback = "";
  for (let i = 0; i <= ctx.config.engine.writer.max_regenerations; i++) {
    out.attempts++;
    try {
      const res = await ctx.llm.run(
        "write_email",
        { system: render(w.prompt.system, w.promptVars), prompt: userPrompt + feedback, promptVersion: w.prompt.version },
        SequenceDraftSchema,
        { companyId: w.company.id, expectedOutputTokens: 3000 },
      );
      out.cost += res.costUsd;
      out.model = res.model;
      out.draft = res.data;
    } catch (err) {
      if (err instanceof SpendCapError || err instanceof LlmExhaustedError || err instanceof NoRouteError) return { ...out, stopped: err };
      throw err;
    }

    const draft = { ...out.draft, subject: w.fixedSubject ?? out.draft.subject, steps: out.draft.steps.map((s) => ({ ...s, body: tidyBody(s.body) })) };
    out.draft = draft;
    const issues: Issue[] = opts.subject ? checkSubject(draft.subject, w.ruleCtx.bannedClaims).map((x) => ({ ...x, message: `subject: ${x.message}` })) : [];
    const got = draft.steps.map((s) => s.step).sort((a, b) => a - b).join(",");
    const want = plan.map((p) => p.step).join(",");
    if (got !== want) issues.push({ code: "step_count", message: `Expected steps ${want}, got ${got}` });
    for (const s of draft.steps) {
      if (!w.personalize && s.fact_ids.length) issues.push({ code: "unknown_fact", message: `step ${s.step}: cites facts but none exist for this company` });
      issues.push(...checkStep(s, w.ruleCtx).map((x) => ({ ...x, message: `step ${s.step}: ${x.message}` })));
    }

    out.criticRan = false;
    if (issues.length === 0) {
      const critic = await runCritic(ctx, w.company.id, draft, w.factAlias, w.proofPoints, recipientJson(w.contact, w.company));
      out.criticScore = critic.score;
      out.criticRan = critic.ran;
      out.cost += critic.cost;
      issues.push(
        ...critic.problems
          .filter((p) => BLOCKING_CRITIC.has(p.kind))
          .map((p) => ({ code: `critic_${p.kind}`, message: `step ${p.step}: ${p.text}` })),
      );
    }
    out.issues = issues;
    if (issues.length === 0) break;
    feedback = `\n\nYour previous draft was rejected for these reasons. Fix every one:\n${issues.map((x) => `- ${x.message}`).join("\n")}`;
  }
  return out;
}

/** What each stored step keeps of its review: verdict, cited facts and their sources. */
function stepVerdict(w: WriteSetup, s: SequenceDraft["steps"][number], r: Drafted, allIssues: Issue[], extra: Record<string, unknown>) {
  const factIds = s.fact_ids.map((a) => w.factAlias.get(a)?.id).filter((x): x is string => !!x);
  return {
    factIds,
    qaVerdict: {
      passed: allIssues.length === 0,
      issues: allIssues.filter((x) => x.message.startsWith(`step ${s.step}:`) || x.message.startsWith("subject:")),
      attempts: r.attempts,
      criticScore: r.criticRan ? r.criticScore : null,
      reviewVersion: reviewVersion(),
      personalized: w.personalize,
      // fact UUID -> text, so human edits can be re-checked against exactly what was cited
      verdictFacts: Object.fromEntries(s.fact_ids.filter((a) => w.factAlias.has(a)).map((a) => [w.factAlias.get(a)!.id, w.factAlias.get(a)!.text])),
      factSources: Object.fromEntries(factIds.map((id) => [id, w.companyFacts.find((f) => f.id === id)?.sourceUrl ?? ""])),
      ...extra,
    },
  };
}

/**
 * Draft the full sequence for one thread, critic it, regenerate on failure, then queue for approval.
 * A rewrite passes what was wrong last time as `feedback` and its `round` (1 = first draft).
 */
export async function writeThread(ctx: Ctx, threadId: string, opts: { feedback?: string; round?: number } = {}): Promise<WriteOutcome> {
  const [t] = await ctx.db.select().from(threads).where(eq(threads.id, threadId));
  if (!t || t.status !== "drafting") return { threadId, status: "skipped", attempts: 0, issues: [], reason: "not drafting" };
  const existing = await ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.threadId, threadId)).limit(1);
  if (existing.length) return { threadId, status: "skipped", attempts: 0, issues: [], reason: "already drafted" };

  const w = await setupWrite(ctx, t);
  if (typeof w === "string") return { threadId, status: "skipped", attempts: 0, issues: [], reason: w };

  // A rewrite keeps the reasons the earlier draft was held through every attempt.
  const held = opts.feedback ? `\n\nAn earlier draft for this company was held back for these reasons. Avoid every one:\n${opts.feedback}` : "";
  const r = await draftChecked(ctx, w, w.plan, render(w.prompt.user, w.promptVars) + held, { subject: true });
  if (r.stopped) {
    if (r.stopped instanceof SpendCapError && r.stopped.scope === "lead") {
      await ctx.db.update(threads).set({ status: "stopped", stopReason: "per-lead LLM cap reached" }).where(eq(threads.id, threadId));
      return { threadId, status: "stopped", attempts: r.attempts, issues: r.issues, reason: r.stopped.message };
    }
    return { threadId, status: "skipped", attempts: r.attempts, issues: r.issues, reason: r.stopped.message };
  }
  const draft = r.draft;
  if (!draft) return { threadId, status: "skipped", attempts: r.attempts, issues: r.issues, reason: "no draft" };

  // Compliance is checked on the composed email (footer included).
  const composed = draft.steps.map((s) => ({ s, full: composeBody(s.body, ctx.config, w.sender) }));
  const complianceIssues = composed.flatMap(({ s, full }) => checkCompliance(full, ctx.config, w.sender).map((x) => ({ ...x, message: `step ${s.step}: ${x.message}` })));
  const allIssues = [...r.issues, ...complianceIssues];
  const decision = await decideApproval(ctx, { passed: allIssues.length === 0, score: r.criticScore });
  const subject = draft.subject.trim();
  const perStepCost = r.cost / Math.max(1, draft.steps.length);

  await ctx.db.transaction(async (tx) => {
    for (const { s, full } of composed) {
      const p = w.plan.find((x) => x.step === s.step);
      if (!p) continue;
      const v = stepVerdict(w, s, r, allIssues, { round: opts.round ?? 1, approvalReason: decision.reason, sampled: decision.sampled ?? false });
      await tx.insert(messages).values({
        threadId,
        contactId: w.contact.id,
        kind: "sequence",
        stepNumber: s.step,
        dayOffset: p.day,
        variant: t.variant,
        subject: s.step === 1 ? subject : `Re: ${subject}`,
        body: full,
        factIds: v.factIds,
        proofPointIds: s.proof_point_ids.filter((id) => w.proofPoints.has(id)),
        promptVersion: w.prompt.version,
        model: r.model,
        costUsd: perStepCost,
        qaVerdict: v.qaVerdict,
        qaScore: r.criticRan ? r.criticScore : null, // null: an earlier check stopped it before the reviewer read it
        approvalState: decision.state,
        status: "draft",
      });
    }
    await tx.update(threads).set({ subject }).where(eq(threads.id, threadId));
  });

  return { threadId, status: decision.state === "needs_review" ? "needs_review" : "drafted", attempts: r.attempts, issues: allIssues };
}

/**
 * When the writer's prompt changes, emails already written but not yet sent are written again under it. A thread
 * that hasn't sent anything yet is rewritten whole, first email and subject included (2026-11-02: the pitch now
 * leads with $0 per user and the switching team); otherwise only its follow-ups, carrying on from the first email
 * as it went out (2026-11-01: step 2 is a plain nudge for people who never replied). Only text the software wrote
 * and no person approved; a rewrite that fails any check, or would need a person where the old one didn't, keeps
 * the old text. Each email is tried once per prompt version.
 */
export async function refreshFollowups(ctx: Ctx, limit = 5): Promise<{ refreshed: number; kept: number }> {
  const version = loadPrompt("write_email").version;
  const unsentFrom = (step: number) =>
    and(
      eq(messages.kind, "sequence"),
      sql`${messages.stepNumber} >= ${step}`,
      inArray(messages.status, ["draft", "scheduled"]),
      inArray(messages.approvalState, ["pending", "auto_approved"]),
      isNull(messages.approvedBy),
      sql`coalesce(${messages.promptVersion}, '') <> ${version}`,
      sql`coalesce(${messages.qaVerdict}->>'refreshedFor', '') <> ${version}`,
    );
  const stale = await ctx.db
    .selectDistinct({ threadId: messages.threadId })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(unsentFrom(1), inArray(threads.status, ["drafting", "active"])))
    .limit(limit);
  let refreshed = 0;
  let kept = 0;

  const refresh = async (threadId: string) => {
    // Nothing sent and nothing a person approved: the whole sequence is still ours to rewrite.
    const touched = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.kind, "sequence"), sql`(${messages.status} not in ('draft', 'scheduled', 'cancelled') or ${messages.approvedBy} is not null)`))
      .limit(1);
    const todo = await ctx.db.select().from(messages).where(and(eq(messages.threadId, threadId), unsentFrom(touched.length ? 2 : 1))).orderBy(asc(messages.stepNumber));
    const whole = todo.some((m) => m.stepNumber === 1);
    const keep = async () => {
      for (const m of todo) await ctx.db.update(messages).set({ qaVerdict: { ...((m.qaVerdict ?? {}) as object), refreshedFor: version } }).where(eq(messages.id, m.id));
      kept += todo.length;
    };
    const [t] = await ctx.db.select().from(threads).where(eq(threads.id, threadId));
    const [first] = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.kind, "sequence"), eq(messages.stepNumber, 1), sql`${messages.status} <> 'cancelled'`));
    const w = t && first ? await setupWrite(ctx, t) : "no first email";
    if (typeof w === "string" || !todo.length) return keep();
    const plan = w.plan.filter((p) => todo.some((m) => m.stepNumber === p.step));
    if (plan.length !== todo.length) return keep(); // a step no longer in the sequence
    const userPrompt = whole
      ? render(w.prompt.user, { ...w.promptVars, steps: stepsText(plan) })
      : render(w.prompt.user, { ...w.promptVars, steps: stepsText(plan) }) +
        `\n\nThe first email (subject "${first!.subject}") is already written and goes out as is:\n${stripFooter(first!.body)}\n\nWrite only the steps listed above, carrying on from it. Repeat the same subject.`;
    const r = await draftChecked(ctx, w, plan, userPrompt, { subject: whole });
    const composed = (r.draft?.steps ?? []).map((s) => ({ s, full: composeBody(s.body, ctx.config, w.sender) }));
    const allIssues = [...r.issues, ...composed.flatMap(({ s, full }) => checkCompliance(full, ctx.config, w.sender).map((x) => ({ ...x, message: `step ${s.step}: ${x.message}` })))];
    const decision = !r.stopped && r.draft && allIssues.length === 0 ? await decideApproval(ctx, { passed: true, score: r.criticScore }) : null;
    // Only where it changes nothing about who has to look at it: sent by itself before, sent by itself now.
    if (!decision || (decision.state !== "auto_approved" && todo.some((m) => m.approvalState !== decision.state))) return keep();
    const subject = whole ? r.draft!.subject.trim() : null;
    for (const { s, full } of composed) {
      const m = todo.find((x) => x.stepNumber === s.step)!;
      const v = stepVerdict(w, s, r, allIssues, { round: 1, approvalReason: decision.reason, sampled: decision.sampled ?? false, refreshedFor: version });
      await ctx.db
        .update(messages)
        .set({
          ...(subject ? { subject: s.step === 1 ? subject : `Re: ${subject}` } : {}),
          body: full,
          factIds: v.factIds,
          proofPointIds: s.proof_point_ids.filter((id) => w.proofPoints.has(id)),
          promptVersion: w.prompt.version,
          model: r.model,
          costUsd: r.cost / Math.max(1, composed.length),
          qaVerdict: v.qaVerdict,
          qaScore: r.criticRan ? r.criticScore : null,
          approvalState: decision.state,
        })
        .where(and(eq(messages.id, m.id), inArray(messages.status, ["draft", "scheduled"])));
    }
    if (subject) await ctx.db.update(threads).set({ subject }).where(eq(threads.id, threadId));
    refreshed += todo.length;
    await audit(ctx.db, "system", whole ? "messages.sequence_refreshed" : "messages.followups_refreshed", "threads", threadId, { steps: plan.map((p) => p.step), promptVersion: version });
  };
  // A few threads at a time, like runWrite, so a backlog after a prompt change clears within the hour.
  for (let i = 0; i < stale.length; i += 5) await Promise.all(stale.slice(i, i + 5).map((x) => refresh(x.threadId)));
  return { refreshed, kept };
}

const recipientJson = (contact: typeof contacts.$inferSelect, company: typeof companies.$inferSelect) =>
  JSON.stringify({ first_name: contact.firstName, title: contact.title, role: contact.role, company: company.name, city: company.city, state: company.state });

/** Which rules a draft was reviewed under; held drafts from older rules are reviewed again (recheckHeld). */
export const reviewVersion = () => `${loadPrompt("critic").version}+words${WORD_RULES_VERSION}`;
const WORD_RULES_VERSION = 2; // 2: word_slack added (2026-10-27)

async function runCritic(
  ctx: Ctx,
  companyId: string,
  draft: SequenceDraft,
  factAlias: Map<string, { text: string }>,
  proofPoints: Map<string, string>,
  recipient: string,
): Promise<{ score: number; problems: z.infer<typeof CriticSchema>["problems"]; cost: number; ran: boolean }> {
  const prompt = loadPrompt("critic");
  const c = ctx.config.business.company;
  try {
    const res = await ctx.llm.run(
      "critic",
      {
        system: prompt.system,
        prompt: render(prompt.user, {
          positioning: `${c.name}: ${c.one_liner}. ${c.thesis}. Strengths: ${c.strengths.join(", ")}.`,
          proof_points: [...proofPoints].map(([id, t]) => `[${id}] ${t}`).join("\n") || "(none)",
          offer: c.offer || "(none)",
          booking_link: c.booking_link || "(none)",
          recipient,
          emails: draft.steps
            .map((s) => {
              const cited = [...s.fact_ids.map((a) => `[${a}] ${factAlias.get(a)?.text ?? "(missing)"}`), ...s.proof_point_ids.map((id) => `[${id}] ${proofPoints.get(id) ?? "(missing)"}`)];
              return `<email step="${s.step}">\n${s.body}\n</email>\n<cited>\n${cited.join("\n") || "(nothing cited)"}\n</cited>`;
            })
            .join("\n\n"),
        }),
        promptVersion: prompt.version,
      },
      CriticSchema,
      { companyId, expectedOutputTokens: 600 },
    );
    return { score: res.data.score, problems: res.data.problems, cost: res.costUsd, ran: true };
  } catch (err) {
    if (err instanceof SpendCapError || err instanceof LlmExhaustedError || err instanceof NoRouteError) {
      // Without the model critic we can't vouch for tone: score 0 forces human approval.
      ctx.log.warn({ err: (err as Error).message }, "critic unavailable; forcing human approval");
      return { score: 0, problems: [], cost: 0, ran: false };
    }
    throw err;
  }
}

/** Draft every thread that is waiting for copy. */
export async function runWrite(ctx: Ctx, limit = 10): Promise<WriteOutcome[]> {
  const rows = await ctx.db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.status, "drafting"),
        notExists(ctx.db.select({ one: messages.id }).from(messages).where(eq(messages.threadId, threads.id))),
      ),
    )
    .limit(limit);
  // A few threads at a time (each is its own company and its own model calls), so a bigger batch still ends quickly.
  const out: WriteOutcome[] = [];
  for (let i = 0; i < rows.length; i += 5) out.push(...(await Promise.all(rows.slice(i, i + 5).map((r) => writeThread(ctx, r.id)))));
  return out;
}

/** Issues that come from missing settings (postal address, sender name), not from the email itself. */
const SETTINGS_ISSUES = new Set(["config_missing", "missing_address", "missing_sender"]);

/**
 * Drafts written before a required setting was filled in (the postal address, typically) were held
 * for review only because of that. Once the setting exists, refresh their footer, check them again,
 * and give them the approval decision they would have had. Drafts with any other issue stay held.
 */
export async function recheckSettingsBlocked(ctx: Ctx, limit = 200): Promise<{ released: number; stillHeld: number }> {
  const held = await ctx.db
    .select({ m: messages, mb: mailboxes })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(messages.kind, "sequence"), eq(messages.status, "draft"), eq(messages.approvalState, "needs_review")))
    .limit(limit);
  const byThread = new Map<string, typeof held>();
  for (const row of held) {
    const issues = (row.m.qaVerdict as { issues?: Issue[] } | null)?.issues ?? [];
    if (!issues.length || !issues.every((i) => SETTINGS_ISSUES.has(i.code))) continue;
    byThread.set(row.m.threadId, [...(byThread.get(row.m.threadId) ?? []), row]);
  }
  let released = 0;
  let stillHeld = 0;
  for (const rows of byThread.values()) {
    const sender = { name: rows[0]!.mb.senderName, title: rows[0]!.mb.senderTitle, phone: rows[0]!.mb.senderPhone };
    const fresh = rows.map(({ m }) => {
      return { m, body: composeBody(stripFooter(m.body), ctx.config, sender) };
    });
    if (fresh.some((f) => checkCompliance(f.body, ctx.config, sender).length)) {
      stillHeld += rows.length;
      continue;
    }
    const verdict = rows[0]!.m.qaVerdict as Record<string, unknown>;
    const score = typeof verdict.criticScore === "number" ? verdict.criticScore : 0;
    const decision = await decideApproval(ctx, { passed: true, score });
    for (const f of fresh) {
      const v = f.m.qaVerdict as Record<string, unknown>;
      await ctx.db
        .update(messages)
        .set({ body: f.body, approvalState: decision.state, qaScore: score, qaVerdict: { ...v, passed: true, issues: [], approvalReason: decision.reason, sampled: decision.sampled ?? false } })
        .where(eq(messages.id, f.m.id));
    }
    released += rows.length;
  }
  return { released, stillHeld };
}

type HeldVerdict = Record<string, unknown> & { verdictFacts?: Record<string, string>; issues?: Issue[] };

/**
 * Held drafts were reviewed under the rules of their day. When the rules change (the reviewer's prompt or
 * the word allowance), each held sequence is reviewed again exactly as written: the ones that pass now get
 * the approval decision they would have had, the rest stay on Approvals with today's reasons. Nothing is
 * rewritten, and each sequence is re-reviewed once per rules version.
 */
export async function recheckHeld(ctx: Ctx, limit = 10): Promise<{ released: number; stillHeld: number }> {
  const version = reviewVersion();
  const stale = await ctx.db
    .selectDistinct({ threadId: messages.threadId })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messages.kind, "sequence"),
        eq(messages.status, "draft"),
        eq(messages.approvalState, "needs_review"),
        inArray(threads.status, ["drafting", "active"]),
        sql`coalesce(${messages.qaVerdict}->>'reviewVersion', '') <> ${version}`,
      ),
    )
    .limit(limit);
  let released = 0;
  let stillHeld = 0;
  const w = ctx.config.engine.writer;
  const proofPoints = new Map(ctx.config.proofPoints.map((p) => [p.id, p.text]));

  for (const { threadId } of stale) {
    const rows = await ctx.db
      .select({ m: messages, mb: mailboxes, c: contacts, co: companies })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
      .innerJoin(contacts, eq(contacts.id, threads.contactId))
      .innerJoin(companies, eq(companies.id, threads.companyId))
      .where(and(eq(messages.threadId, threadId), eq(messages.kind, "sequence"), eq(messages.status, "draft"), eq(messages.approvalState, "needs_review")))
      .orderBy(asc(messages.stepNumber));
    if (!rows.length) continue;
    const { mb, c, co } = rows[0]!;
    const sender = { name: mb.senderName, title: mb.senderTitle, phone: mb.senderPhone };

    // The facts each step cited, under short aliases like the writer's.
    const aliasOf = new Map<string, string>();
    const factAlias = new Map<string, { text: string }>();
    for (const { m } of rows) {
      for (const [id, text] of Object.entries((m.qaVerdict as HeldVerdict | null)?.verdictFacts ?? {})) {
        if (aliasOf.has(id)) continue;
        aliasOf.set(id, `f${aliasOf.size + 1}`);
        factAlias.set(aliasOf.get(id)!, { text });
      }
    }
    const step1 = rows.find(({ m }) => m.stepNumber === 1)?.m;
    const draft: SequenceDraft = {
      subject: step1?.subject ?? "",
      steps: rows.map(({ m }) => ({
        step: m.stepNumber,
        body: stripFooter(m.body),
        fact_ids: m.factIds.map((id) => aliasOf.get(id)).filter((a): a is string => !!a),
        proof_point_ids: m.proofPointIds,
      })),
    };
    const ruleCtx = {
      facts: new Map([...factAlias].map(([a, f]) => [a, f.text])),
      proofPoints,
      bannedClaims: ctx.config.business.company.banned_claims,
      minWords: w.min_words,
      followupMinWords: w.followup_min_words,
      maxWords: w.max_words + w.word_slack,
      bookingLink: ctx.config.business.company.booking_link,
      };
    const issues: Issue[] = step1 ? checkSubject(step1.subject, ruleCtx.bannedClaims).map((x) => ({ ...x, message: `subject: ${x.message}` })) : [];
    for (const s of draft.steps) issues.push(...checkStep(s, ruleCtx).map((x) => ({ ...x, message: `step ${s.step}: ${x.message}` })));
    for (const { m } of rows) {
      const full = composeBody(stripFooter(m.body), ctx.config, sender);
      issues.push(...checkCompliance(full, ctx.config, sender).map((x) => ({ ...x, message: `step ${m.stepNumber}: ${x.message}` })));
    }

    let score: number | null = null;
    if (issues.length === 0) {
      const critic = await runCritic(ctx, co.id, draft, factAlias, proofPoints, recipientJson(c, co));
      if (critic.ran) {
        score = critic.score;
        issues.push(...critic.problems.filter((p) => BLOCKING_CRITIC.has(p.kind)).map((p) => ({ code: `critic_${p.kind}`, message: `step ${p.step}: ${p.text}` })));
      } else {
        // No reviewer right now (spend cap or no model): it stays held with its earlier reasons.
        issues.push(...rows.flatMap(({ m }) => (m.qaVerdict as HeldVerdict | null)?.issues ?? []));
      }
    }

    const decision = issues.length === 0 ? await decideApproval(ctx, { passed: true, score: score ?? 0 }) : null;
    for (const { m } of rows) {
      const v = (m.qaVerdict ?? {}) as HeldVerdict;
      const mine = issues.filter((x) => x.message.startsWith(`step ${m.stepNumber}:`) || (m.stepNumber === 1 && x.message.startsWith("subject:")));
      await ctx.db
        .update(messages)
        .set(
          decision
            ? { approvalState: decision.state, qaScore: score, qaVerdict: { ...v, passed: true, issues: [], criticScore: score, reviewVersion: version, approvalReason: decision.reason, sampled: decision.sampled ?? false } }
            : { qaScore: score, qaVerdict: { ...v, passed: false, issues: mine, criticScore: score, reviewVersion: version } },
        )
        .where(eq(messages.id, m.id));
    }
    if (decision) {
      released += rows.length;
      await audit(ctx.db, "system", "messages.recheck_released", "threads", threadId, { state: decision.state, score, reviewVersion: version });
    } else stillHeld += rows.length;
  }
  return { released, stillHeld };
}

/** Rewrites per sequence before a person decides: the first draft plus this many. */
const MAX_ROUNDS = 2;

/**
 * Write a held sequence again from scratch, telling the writer what was wrong. Only sequences nothing
 * has gone out from: their drafts are replaced. Returns null when the thread can't be rewritten.
 */
export async function redraftThread(ctx: Ctx, threadId: string, actor = "system"): Promise<WriteOutcome | null> {
  const [t] = await ctx.db.select().from(threads).where(eq(threads.id, threadId));
  if (!t || t.status !== "drafting") return null;
  const msgs = await ctx.db.select().from(messages).where(eq(messages.threadId, threadId));
  if (msgs.some((m) => m.status !== "draft" && m.status !== "cancelled")) return null; // something already went out or is due
  const drafts = msgs.filter((m) => m.status === "draft");
  if (!drafts.length) return null;
  const reasons = [...new Set(drafts.flatMap((m) => ((m.qaVerdict as HeldVerdict | null)?.issues ?? []).map((i) => `- ${i.message}`)))];
  const lowScore = drafts.find((m) => m.approvalState === "pending" && typeof m.qaScore === "number")?.qaScore;
  if (!reasons.length && lowScore != null) reasons.push(`- The reviewer scored it ${lowScore}/100: make it more specific to this company and easier to answer.`);
  const round = Math.max(...drafts.map((m) => Number((m.qaVerdict as HeldVerdict | null)?.round ?? 1))) + 1;
  await ctx.db.delete(messages).where(eq(messages.threadId, threadId));
  await audit(ctx.db, actor, "thread.redraft", "threads", threadId, { round, reasons });
  return writeThread(ctx, threadId, { feedback: reasons.join("\n"), round });
}

/**
 * The software, not a person, deals with held emails: a sequence the checks held back (or the reviewer
 * scored too low to send) is rewritten with the reasons, once. Only what is still held after that, the
 * odd ones, waits for a person on Approvals. Runs after recheckHeld, so drafts are judged by today's rules first.
 */
export async function redraftHeld(ctx: Ctx, limit = 3): Promise<WriteOutcome[]> {
  const version = reviewVersion();
  const rows = await ctx.db
    .selectDistinct({ threadId: messages.threadId })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messages.kind, "sequence"),
        eq(messages.status, "draft"),
        eq(threads.status, "drafting"),
        sql`(${messages.approvalState} = 'needs_review' or (${messages.approvalState} = 'pending' and ${messages.qaVerdict}->>'approvalReason' like 'critic score%'))`,
        sql`coalesce(${messages.qaVerdict}->>'reviewVersion', '') = ${version}`,
        sql`coalesce((${messages.qaVerdict}->>'round')::int, 1) < ${MAX_ROUNDS}`,
      ),
    )
    .limit(limit * 10);
  const out: WriteOutcome[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    // Held only for a missing setting (the postal address): rewriting can't fix that; recheckSettingsBlocked does.
    const issues = (await ctx.db.select({ v: messages.qaVerdict }).from(messages).where(eq(messages.threadId, r.threadId))).flatMap((m) => (m.v as HeldVerdict | null)?.issues ?? []);
    if (issues.length && issues.every((i) => SETTINGS_ISSUES.has(i.code))) continue;
    const res = await redraftThread(ctx, r.threadId);
    if (res) out.push(res);
  }
  return out;
}

/** "https://www.example.com/x" -> "example.com"; null when the site isn't a URL. */
function siteHostOf(site: string): string | null {
  try {
    return new URL(site).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
