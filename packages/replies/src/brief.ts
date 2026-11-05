import { brandVars, companies, contacts, facts, LlmExhaustedError, loadPrompt, meetings, newReplyText, NoRouteError, render, replies, SpendCapError, type Ctx, type LeadBrief } from "@opengtm/core";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { loadConversation } from "./conversation";

const BriefSchema = z.object({
  headline: z.string(),
  person: z.array(z.string()),
  company: z.array(z.object({ text: z.string(), fact_id: z.string().nullable() })),
  current_tools: z.string().nullable(),
  show_them: z.array(z.object({ feature: z.string(), why: z.string() })),
  questions: z.array(z.string()),
  watch_outs: z.array(z.string()),
});

/**
 * Demo prep for a hot lead (added 2026-11-04): who they are, their company (each point linked to the page it
 * came from), what they use today, what to show, questions to ask and watch-outs, written only from the
 * stored facts, the lead record and the conversation. Saved on the hot-lead record; null when no model.
 */
export async function prepareBrief(ctx: Ctx, meetingId: string): Promise<LeadBrief | null> {
  const [m] = await ctx.db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!m) return null;
  const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, m.contactId));
  const [company] = await ctx.db.select().from(companies).where(eq(companies.id, m.companyId));
  if (!contact || !company) return null;
  const [r] = m.replyId ? await ctx.db.select().from(replies).where(eq(replies.id, m.replyId)) : [];
  const convo = m.replyId ? await loadConversation(ctx, m.replyId) : null;
  const known = await ctx.db.select().from(facts).where(eq(facts.companyId, company.id)).orderBy(asc(facts.createdAt));
  const alias = new Map(known.map((f, i) => [`f${i + 1}`, f]));

  const c = ctx.config.business.company;
  const prompt = loadPrompt("lead_brief");
  const vars = {
    ...brandVars(ctx.config),
    person: [
      [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email,
      contact.title ? `Title: ${contact.title}` : "",
      contact.role ? `Role: ${contact.role}` : "",
      `Email: ${contact.email}`,
    ]
      .filter(Boolean)
      .join("\n"),
    company: [
      company.name,
      company.website ?? company.domain,
      [company.city, company.state].filter(Boolean).join(", "),
      company.companySize ? `${company.companySize} people` : "",
      company.focusAreas.length ? `Focus areas: ${company.focusAreas.join(", ")}` : "",
      company.signals.length ? `Signals: ${company.signals.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    facts: [...alias].map(([id, f]) => `[${id}] ${f.text}`).join("\n") || "(nothing researched)",
    conversation: convo?.text.slice(-5000) || "(none)",
    their_reply: r ? (newReplyText(r.body) || r.body).slice(0, 3000) : "(none)",
    one_liner: c.one_liner,
    strengths: c.strengths.join(", "),
    proof_points: ctx.config.proofPoints.map((p) => `[${p.id}] ${p.text}`).join("\n") || "(none)",
    pricing: c.pricing || "(not listed)",
    competitors: ctx.config.business.competitors.join(", ") || "(none listed)",
  };
  let data: z.infer<typeof BriefSchema>;
  try {
    const res = await ctx.llm.run("lead_brief", { system: render(prompt.system, vars), prompt: render(prompt.user, vars), promptVersion: prompt.version }, BriefSchema, {
      companyId: company.id,
      expectedOutputTokens: 1500,
    });
    data = res.data;
  } catch (err) {
    if (err instanceof SpendCapError || err instanceof LlmExhaustedError || err instanceof NoRouteError) return null;
    throw err;
  }
  const brief: LeadBrief = {
    headline: data.headline.trim(),
    person: data.person.map((s) => s.trim()).filter(Boolean),
    // A point citing a fact we don't have is dropped: the brief only says what was found.
    company: data.company.flatMap((p): LeadBrief["company"] => {
      if (!p.fact_id) return [{ text: p.text.trim(), source: null }];
      const f = alias.get(p.fact_id);
      return f ? [{ text: p.text.trim(), source: f.sourceUrl }] : [];
    }),
    currentTools: data.current_tools?.trim() || null,
    showThem: data.show_them.slice(0, 4),
    questions: data.questions.slice(0, 5),
    watchOuts: data.watch_outs.slice(0, 3),
    promptVersion: prompt.version,
  };
  await ctx.db.update(meetings).set({ brief, briefAt: ctx.clock.now(), updatedAt: ctx.clock.now() }).where(eq(meetings.id, meetingId));
  return brief;
}
