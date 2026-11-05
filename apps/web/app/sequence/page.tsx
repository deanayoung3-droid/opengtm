import { mailboxes, messages, sequenceSteps, threads } from "@opengtm/core";
import { asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { ConfirmButton } from "../../components/ConfirmButton";
import { Badge, Empty, Flash, PageHeader, PageTitle, Section } from "../../components/ui";
import { EmailPreview } from "../../components/EmailPreview";
import { rtReady } from "../../lib/runtime";
import { saveSequenceAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email sequence" };

export default async function Sequence({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await rtReady();
  const [steps, mbs, [example]] = await Promise.all([
    ctx.db.select().from(sequenceSteps).where(eq(sequenceSteps.variant, "A")).orderBy(asc(sequenceSteps.stepNumber)),
    ctx.db.select().from(mailboxes).orderBy(asc(mailboxes.email)),
    ctx.db.select().from(messages).where(eq(messages.stepNumber, 1)).orderBy(desc(messages.createdAt)).limit(1),
  ]);
  const [exampleThread] = example ? await ctx.db.select({ mailboxId: threads.mailboxId }).from(threads).where(eq(threads.id, example.threadId)) : [];
  const exampleSender = mbs.find((mb) => mb.id === (example?.mailboxId ?? exampleThread?.mailboxId));
  const w = ctx.config.engine.writer;
  const seen = new Set<number>();
  const plan = steps.filter((s) => !seen.has(s.stepNumber) && seen.add(s.stepNumber));

  return (
    <>
      <PageHeader icon="send" title="Email sequence" />
      <PageTitle title="Email sequence">How every lead's emails are written. The writer follows these instructions, uses only the facts on Project docs and what it researched about the company, and a checker rejects anything it can't back up.</PageTitle>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="split" style={{ alignItems: "start" }}>
        <div>
          <form action={saveSequenceAction}>
            <Section title="Instructions" sub="Like a brief to a copywriter: the call to action, tone, what to avoid. Applies to every campaign.">
              <div className="card stack">
                <label className="field">
                  <span>Writing instructions</span>
                  <textarea name="instructions" className="tall" defaultValue={ctx.config.business.outreach.instructions} placeholder={`e.g. Keep it short and specific to their business. Casual, plain tone.`} />
                </label>
                <label className="field">
                  <span>Reply word</span>
                  <input name="cta_reply" defaultValue={ctx.config.business.outreach.cta_reply} maxLength={20} required placeholder="yes" />
                  <span className="small muted">The first email asks people to reply with just this word to get the offer. Saying yes should cost them nothing.</span>
                </label>
                <div className="meta-line">
                  <span>
                    Length <b>{w.min_words}-{w.max_words} words</b>
                  </span>
                  <span>
                    <b>One question</b> per email
                  </span>
                  <span>
                    <b>No links</b> in the first email
                  </span>
                  <span>
                    Offer: <b>{ctx.config.business.company.offer || "not set"}</b>
                  </span>
                </div>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <ConfirmButton className="primary">Save instructions</ConfirmButton>
                </div>
              </div>
            </Section>
          </form>

          <Section title="Steps" sub={`Each lead gets up to ${plan.length || ctx.config.engine.sequence.steps.length} emails in one thread. Any reply, bounce or opt-out stops the rest.`}>
            {plan.length === 0 ? (
              <Empty icon="send" title="No sequence yet">It is created with the first campaign run.</Empty>
            ) : (
              <div className="card">
                <ol className="timeline">
                  {plan.map((s) => (
                    <li key={s.id}>
                      <div className="day">{s.dayOffset === 0 ? "Day 0, first email" : `Day ${s.dayOffset}, if no reply`}</div>
                      {s.instructions}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </Section>
        </div>

        <div>
          <Section title="Senders" sub={`Each mailbox sends as its own name. Emails sign off with it and say they're from ${ctx.config.business.company.name}.`}>
            {mbs.length === 0 ? (
              <Empty icon="mailboxes" title="No mailboxes connected">
                Add them on <Link href="/mailboxes">Channels</Link>.
              </Empty>
            ) : (
              <div className="card flush">
                <ul className="plain todo">
                  {mbs.map((m) => (
                    <li key={m.id}>
                      <div style={{ flex: 1 }}>
                        <div className="strong">{m.senderName}</div>
                        <div className="small muted">{m.email}</div>
                      </div>
                      <Badge value={m.status} dot />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          <Section title="What leads get" sub="The most recent first email the writer produced.">
            {example ? (
              <div className="card stack">
                <div className="strong">{example.subject}</div>
                <EmailPreview body={example.body} mailbox={exampleSender} config={ctx.config} />
              </div>
            ) : (
              <Empty icon="file" title="No example yet">The first drafts appear here and in Approvals.</Empty>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
