import {
  companies,
  contacts,
  getAutoReply,
  LlmExhaustedError,
  loadPrompt,
  mailboxes,
  newReplyText,
  NoRouteError,
  render,
  replies,
  SpendCapError,
  threads,
  wordCount,
  type Ctx,
} from "@opengtm/core";
import { checkStep, composeBody, tidyBody, type Issue } from "@opengtm/writer";
import { eq } from "drizzle-orm";
import { loadConversation } from "./conversation";
import { z } from "zod";

/** Labels whose replies never go out without a person (on top of hot leads). */
export const NO_AUTO_REPLY = new Set(["other", "hostile", "unsubscribe", "bounce", "out_of_office"]);

export const ReplyDraftSchema = z.object({
  body: z.string().describe("Plain-text reply body without signature"),
  proof_point_ids: z.array(z.string()),
});

const MIN_WORDS = 15;
const MAX_WORDS = 160;

/**
 * Same hard rules as the sequence writer, adapted to a 1:1 conversation: numbers may come from
 * pricing, reply facts, the demo offer, the company's research or the conversation itself (`known`).
 */
export function checkReplyDraft(ctx: Ctx, body: string, proofPointIds: string[], label: string, hot = false, known = ""): Issue[] {
  const allowed = [ctx.config.business.company.pricing, ctx.config.business.facts, ctx.config.business.company.offer, ctx.config.business.outreach.demo_offer, known].join("\n");
  // Checked like a later follow-up (step 3): a reply may point to the demo and the booking link; step 2 may not.
  const issues = checkStep(
    { step: 3, body, fact_ids: ["_known"], proof_point_ids: proofPointIds },
    {
      facts: new Map([["_known", allowed]]),
      proofPoints: new Map(ctx.config.proofPoints.map((p) => [p.id, p.text])),
      bannedClaims: ctx.config.business.company.banned_claims,
      minWords: MIN_WORDS,
      maxWords: MAX_WORDS,
      bookingLink: ctx.config.business.company.booking_link,
    },
  ).filter((i) => {
    if (i.code === "question_cta" || i.code === "link_in_step1" || i.code === "word_count") return false;
    // Meeting times ("2pm", "10:30") are fine in a reply.
    const n = i.code === "unsupported_number" ? i.message.match(/^"([^"]+)"/)?.[1] : null;
    if (n && new RegExp(`\\b${n.replace(/[.%]/g, "\\$&")}\\s*(:\\d\\d|[ap]\\.?m\\b)|\\d:${n}\\b`, "i").test(body)) return false;
    // "free 7-day trial" is a spam phrase in a cold email, but fine when it is your actual pricing and they asked.
    const spam = i.code === "spam_words" ? i.message.match(/"(.+)"/)?.[1] : null;
    return !(spam && allowed.toLowerCase().includes(spam.toLowerCase()));
  });
  const link = ctx.config.business.company.booking_link;
  const buying = hot || label === "interested" || label === "question";
  if (buying && link && !body.includes(link)) {
    issues.push({ code: "missing_booking_link", message: `Include the link ${link} exactly` });
  }
  // Steer toward a call: a hot reply asks them something (usually whether a call with the founders would help).
  const offer = ctx.config.business.outreach.demo_offer;
  if (buying && !body.includes("?")) issues.push({ code: "no_next_step", message: `Ask one simple question offering ${offer}, booked at the link` });
  const words = wordCount(body);
  if (words < MIN_WORDS || words > MAX_WORDS) issues.push({ code: "word_count", message: `${words} words` });
  return issues;
}

/** Draft a response to a hot lead or objection. Always held for human approval unless configured otherwise. */
export async function draftReply(ctx: Ctx, replyId: string): Promise<{ drafted: boolean; issues: Issue[] }> {
  const [r] = await ctx.db.select().from(replies).where(eq(replies.id, replyId));
  if (!r || !r.threadId || !r.contactId) return { drafted: false, issues: [] };
  const [t] = await ctx.db.select().from(threads).where(eq(threads.id, r.threadId));
  const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, r.contactId));
  const [company] = t ? await ctx.db.select().from(companies).where(eq(companies.id, t.companyId)) : [];
  const [mb] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, r.mailboxId));
  const convo = await loadConversation(ctx, replyId);
  if (!contact || !company || !mb || !convo) return { drafted: false, issues: [] };

  const c = ctx.config.business.company;
  const asks = (r.summary ?? "").match(/Asks: (.+)$/)?.[1];
  const prompt = loadPrompt("reply_draft");
  const vars = {
    label: r.hot && r.label !== "interested" && r.label !== "question" ? `${r.label} (flagged as a hot lead)` : (r.label ?? "other"),
    questions: asks ? `\nTheir questions: ${asks}` : "",
    next_step: r.summary ?? "",
    recipient: convo.who,
    company_facts: convo.companyFacts.map((f) => `- ${f}`).join("\n") || "(nothing researched)",
    company_name: c.name,
    one_liner: c.one_liner,
    strengths: c.strengths.join(", "),
    proof_points: ctx.config.proofPoints.map((p) => `[${p.id}] ${p.text}`).join("\n") || "(none)",
    booking_link: c.booking_link || "(none)",
    offer: c.offer || "(none)",
    pricing: c.pricing || "(not listed: say you will confirm)",
    competitors: ctx.config.business.competitors.join(", ") || "(none listed)",
    facts: ctx.config.business.facts || "(none)",
    demo_offer: ctx.config.business.outreach.demo_offer,
    instructions: ctx.config.business.outreach.instructions || "(none)",
    sender: mb.senderName,
    conversation: convo.text.slice(-5000) || "(none)",
    their_reply: (newReplyText(r.body) || r.body).slice(0, 4000),
  };
  const base = render(prompt.user, vars);
  const system = render(prompt.system, vars);

  let issues: Issue[] = [];
  let body = "";
  let feedback = "";
  // A plain yes gets the team's own answer, word for word (decided 2026-11-04): the preview, the $0, the
  // founders' call ({{first_name}} and {{booking_link}} filled in). Questions, objections and anything else are still written for what they said.
  const yesReply = ctx.config.business.outreach.yes_reply.trim();
  if (yesReply && r.hot && r.label === "interested" && !asks) {
    body = tidyBody(render(yesReply, { first_name: contact.firstName?.trim() || "there", booking_link: c.booking_link }));
  } else {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await ctx.llm.run("reply_draft", { system, prompt: base + feedback, promptVersion: prompt.version }, ReplyDraftSchema, {
          companyId: company.id,
          expectedOutputTokens: 1500,
        });
        body = tidyBody(res.data.body);
        issues = checkReplyDraft(ctx, body, res.data.proof_point_ids, r.label ?? "", r.hot, `${convo.text}\n${vars.their_reply}\n${convo.companyFacts.join("\n")}`);
      } catch (err) {
        if (err instanceof SpendCapError || err instanceof LlmExhaustedError || err instanceof NoRouteError) {
          return { drafted: false, issues: [{ code: "llm_unavailable", message: (err as Error).message }] };
        }
        throw err;
      }
      if (!issues.length) break;
      feedback = `\n\nYour previous draft was rejected. Fix: ${issues.map((x) => x.message).join("; ")}`;
    }
  }
  // Even an imperfect draft is saved for the human, who sees the issues next to it. A clean
  // draft sends by itself after the review window; hot leads and unclear replies always wait for a person.
  const auto = await getAutoReply(ctx.db, ctx.config.engine.replies.auto_reply);
  const autoOk = auto.enabled && !issues.length && !r.hot && !NO_AUTO_REPLY.has(r.label ?? "other");
  await ctx.db
    .update(replies)
    .set({
      draftBody: composeBody(body, ctx.config, { name: mb.senderName, title: mb.senderTitle, phone: mb.senderPhone }),
      draftState: "pending",
      autoSendAt: autoOk ? new Date(ctx.clock.now().getTime() + auto.delayMinutes * 60_000) : null,
    })
    .where(eq(replies.id, replyId));
  return { drafted: true, issues };
}
