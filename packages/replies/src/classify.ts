import { LlmExhaustedError, newReplyText, loadPrompt, NoRouteError, REPLY_LABELS, render, SpendCapError, type Ctx, type DecisionQuestion, type ReplyLabel, brandVars } from "@opengtm/core";
import { z } from "zod";
import { parseReturnDate, preClassify } from "./rules";

export const ClassifySchema = z.object({
  label: z.enum(REPLY_LABELS),
  confidence: z.number().min(0).max(1),
  summary: z.string().describe("One sentence: what they said and what they want"),
  referral: z
    .object({ name: z.string().nullable(), email: z.string().nullable(), title: z.string().nullable() })
    .nullable()
    .describe("Person they pointed us to, or for email_changed the same person's new address"),
  ooo_until: z.string().nullable().describe("Return date as YYYY-MM-DD if out of office, else null"),
  remove_whole_company: z.boolean().describe("True if they asked us to stop contacting everyone at their company"),
  hot: z.boolean().default(false).describe("True if a salesperson should answer them today: said yes, wants the preview or a demo, or asked a buying question"),
  reply_needed: z.boolean().default(true).describe("False when answering would add nothing (a bare 'no thanks', an auto-reply, an unsubscribe)"),
  questions: z.array(z.string()).default([]).describe("Each question they asked, in their words, shortened"),
  next_step: z.string().default("").describe("The single best next step for our team, in a few words"),
});
export type ClassifyOutput = z.infer<typeof ClassifySchema>;

export interface Classification {
  label: ReplyLabel;
  confidence: number;
  summary: string;
  referral: ClassifyOutput["referral"];
  oooUntil: Date | null;
  removeWholeCompany: boolean;
  by: string;
  /** The "Hot lead" flag; defaults from the label when no model said otherwise. */
  hot?: boolean;
  replyNeeded?: boolean;
  questions?: string[];
  nextStep?: string;
}

const HOT_LABELS = new Set<ReplyLabel>(["interested", "question"]);
const NO_REPLY_LABELS = new Set<ReplyLabel>(["out_of_office", "unsubscribe", "hostile", "bounce", "recipient_gone", "email_changed"]);

/** Hot and reply-needed with sensible defaults per label. */
export function withDefaults(c: Classification): Classification & { hot: boolean; replyNeeded: boolean; questions: string[]; nextStep: string } {
  return {
    ...c,
    hot: c.hot ?? HOT_LABELS.has(c.label),
    replyNeeded: c.replyNeeded ?? !NO_REPLY_LABELS.has(c.label),
    questions: c.questions ?? [],
    nextStep: c.nextStep ?? "",
  };
}

/** Same definitions the LLM prompt uses, so both paths label consistently. */
export const LABEL_CRITERIA: Record<ReplyLabel, string> = {
  interested: "Wants to talk, see a demo, or get meeting times; positive intent",
  question: "Asks a genuine question about the product (pricing, features, migration) without committing",
  objection: "Declines or pushes back (happy with current tool, too expensive, too busy, sceptical it's different, 'no thank you') but is not hostile",
  not_now: "Not a fit right now but open to hearing again later",
  wrong_person: "Says they are not the right contact, without naming anyone",
  referral: "Names or forwards to another person who handles this",
  out_of_office: "An away notice: temporarily unavailable or not checking email for a period (vacation, leave, in trial), even if typed by hand",
  email_changed: "This person changed address or moved to another company and gives a new email address to use",
  recipient_gone: "This person no longer works there (left, retired) and gives no new address",
  unsubscribe: "Asks to stop receiving emails, politely or curtly",
  hostile: "Angry, threatens to report spam, or abusive",
  bounce: "A delivery failure notice from a mail server",
  other: "Anything else, including unclear replies",
};

const REPLY_QUESTIONS: Record<string, DecisionQuestion> = {
  label: {
    type: "choice",
    instructions: "Which label best describes this reply to a cold sales email that a company sent to another business?",
    criteria: LABEL_CRITERIA,
  },
  whole_firm: { type: "noul", instructions: "The reply asks that nobody at their company be contacted again" },
};

function replyState(r: ReplyInput): string {
  return `Reply from ${r.fromEmail}\nSubject: ${r.subject}\n\n${r.body.slice(0, 6000)}`;
}

function summarize(label: ReplyLabel, body: string): string {
  const first = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return `${label.replace("_", " ")}: "${first.slice(0, 140)}"`;
}

/** Referred person's email from the reply text (anything that isn't the sender). */
export function referralFromBody(body: string, fromEmail: string): ClassifyOutput["referral"] {
  const email = (body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((e) => e.toLowerCase()).find((e) => e !== fromEmail.toLowerCase());
  return email ? { name: null, email, title: null } : null;
}

export interface ReplyInput {
  subject: string;
  body: string;
  classifiedBy: string | null;
  fromEmail: string;
  ourLastEmail?: string;
  /** The whole conversation so far, oldest first, so a "yes" or "what about X?" is read in context. */
  conversation?: string;
  /** Who they are: "Jane Doe, Owner at Doe Landscaping (landscaping, TX)". */
  who?: string;
}

/**
 * Rules first (auto-replies, bare unsubscribes), then the local model, escalating
 * to the API model when the local model is unsure. If no model is reachable the
 * reply is labeled "other" with zero confidence so a human sees it.
 */
export async function classifyReply(ctx: Ctx, r: ReplyInput, opts: { companyId?: string | null } = {}): Promise<Classification> {
  const now = ctx.clock.now();
  const rule = preClassify(r, now);
  if (rule) {
    const summary =
      rule.summary ??
      ({ out_of_office: "Auto-reply: out of office", email_changed: `Moved; new address ${rule.newEmail}`, recipient_gone: "No longer at the company" }[rule.label as string] ?? "Asked to stop");
    return { ...rule, summary, referral: rule.newEmail ? { name: null, email: rule.newEmail, title: null } : null, by: "rules" };
  }
  const fresh = newReplyText(r.body) || r.body.trim();

  const prompt = loadPrompt("reply_classify");
  const input = {
    system: render(prompt.system, brandVars(ctx.config)),
    prompt: render(prompt.user, {
      today: now.toISOString().slice(0, 10),
      our_email: (r.ourLastEmail ?? "(not available)").slice(0, 2000),
      conversation: (r.conversation ?? "(only our last email, above)").slice(-6000),
      who: r.who ?? r.fromEmail,
      from: r.fromEmail,
      subject: r.subject,
      body: fresh.slice(0, 6000),
    }),
    promptVersion: prompt.version,
  };

  const toResult = (d: ClassifyOutput, by: string): Classification => ({
    label: d.label,
    confidence: d.confidence,
    summary: d.summary,
    referral: d.referral,
    oooUntil: d.ooo_until ? (Number.isNaN(Date.parse(d.ooo_until)) ? parseReturnDate(r.body, now) : new Date(`${d.ooo_until}T14:00:00Z`)) : null,
    removeWholeCompany: d.remove_whole_company,
    by,
    hot: d.hot || HOT_LABELS.has(d.label),
    replyNeeded: d.reply_needed,
    questions: d.questions,
    nextStep: d.next_step,
  });

  const minConfidence = ctx.config.engine.replies.classify_min_confidence;
  const unavailable = (err: unknown) => err instanceof LlmExhaustedError || err instanceof NoRouteError || err instanceof SpendCapError;

  // 1) Decision model (Jev): cheapest and fastest; it only picks a label.
  let local: Classification | null = null;
  let decisionTried = false;
  try {
    const d = await ctx.llm.decide("reply_classify", replyState({ ...r, body: fresh }), REPLY_QUESTIONS, { companyId: opts.companyId });
    decisionTried = true;
    const label = d.answers.label;
    const company = d.answers.whole_firm;
    if (label?.type === "choice") {
      const lbl = label.choice as ReplyLabel;
      local = {
        label: lbl,
        confidence: label.confidence,
        summary: summarize(lbl, fresh),
        referral: lbl === "referral" || lbl === "wrong_person" || lbl === "email_changed" ? referralFromBody(r.body, r.fromEmail) : null,
        oooUntil: lbl === "out_of_office" ? parseReturnDate(`${r.subject} ${r.body}`, now) : null,
        removeWholeCompany: company?.type === "noul" ? company.noul >= 0.5 : false,
        by: `decision:${d.model}`,
      };
      if (local.confidence >= minConfidence) return local;
    }
  } catch (err) {
    if (!unavailable(err)) throw err;
  }

  // 2) Without a decision model, the LLM route is primary. If the decision model was unsure, go straight to escalation.
  if (!decisionTried) {
    try {
      const res = await ctx.llm.run("reply_classify", input, ClassifySchema, { companyId: opts.companyId, expectedOutputTokens: 300 });
      local = toResult(res.data, `model:${res.model}`);
      if (local.confidence >= minConfidence) return local;
    } catch (err) {
      if (!unavailable(err)) throw err;
    }
  }
  try {
    const res = await ctx.llm.run("reply_classify_escalate", input, ClassifySchema, { companyId: opts.companyId, expectedOutputTokens: 300 });
    return toResult(res.data, `escalated:${res.model}`);
  } catch (err) {
    if (!(err instanceof LlmExhaustedError || err instanceof NoRouteError || err instanceof SpendCapError)) throw err;
  }
  return local ?? { label: "other", confidence: 0, summary: "Could not classify automatically; needs a human", referral: null, oooUntil: null, removeWholeCompany: false, by: "none" };
}
