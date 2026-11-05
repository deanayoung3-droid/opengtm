import { campaigns, companies, contacts, mailboxes, messages, threads } from "@opengtm/core";
import { and, asc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { ConfirmButton } from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { Badge, Empty, Flash, PageHeader, PageTitle, Person, pretty, Section } from "../../components/ui";
import { name } from "../../lib/format";
import { EmailPreview } from "../../components/EmailPreview";
import { rtReady } from "../../lib/runtime";
import { approveMsg, bulkApproveMsgs, rejectMsg, rewriteThreadAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approvals" };

type Verdict = {
  issues?: { code: string; message: string }[];
  personalized?: boolean;
  verdictFacts?: Record<string, string>;
  factSources?: Record<string, string>;
};

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
};

export default async function Approvals({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const sp = await searchParams;
  const { ctx } = (await rtReady());
  const rows = await ctx.db
    .select({ m: messages, t: threads, c: contacts, co: companies, seg: campaigns.segmentId, mb: mailboxes })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .innerJoin(companies, eq(companies.id, threads.companyId))
    .innerJoin(campaigns, eq(campaigns.id, threads.campaignId))
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(messages.status, "draft"), inArray(messages.approvalState, ["pending", "needs_review"])))
    .orderBy(asc(messages.createdAt), asc(messages.stepNumber))
    .limit(200);

  type Row = (typeof rows)[number];
  const isFlagged = (r: Row) => r.m.approvalState === "needs_review" || Boolean((r.m.qaVerdict as Verdict | null)?.issues?.length);
  const byThread = new Map<string, Row[]>();
  for (const r of rows) byThread.set(r.t.id, [...(byThread.get(r.t.id) ?? []), r]);
  const groups = [...byThread.values()];
  const flagged = groups.filter((g) => g.some(isFlagged));
  const ready = groups.filter((g) => !g.some(isFlagged));
  const readyIds = ready.flat().map((r) => r.m.id);
  const proof = new Map(ctx.config.proofPoints.map((p) => [p.id, p.text]));

  const thread = (msgs: Row[], canBulk: boolean) => {
    const { t, c, co, seg, mb } = msgs[0]!;
    return (
      <article key={t.id} className="card flush">
        <div className="card-head">
          <Person name={name(c)} meta={[c.title, c.email].filter(Boolean).join(" · ")} />
          <div className="meta-line" style={{ marginLeft: 12 }}>
            <Link href={`/leads/${co.id}`}>
              <b>{co.name}</b>
            </Link>
            <span>{co.state ?? "State unknown"}</span>
            <span>{pretty(seg)}</span>
            <span>Sent by {mb.senderName}</span>
          </div>
          {!canBulk && (
            <form action={rewriteThreadAction} className="actions">
              <input type="hidden" name="thread" value={t.id} />
              <ConfirmButton className="primary" confirm="Write this sequence again, avoiding the problems listed? The current drafts are replaced.">
                <Icon name="sparkle" /> Rewrite
              </ConfirmButton>
            </form>
          )}
          {canBulk && (
            <form action={bulkApproveMsgs} className="actions">
              {msgs.map(({ m }) => (
                <input key={m.id} type="hidden" name="ids" value={m.id} />
              ))}
              <ConfirmButton className="primary">
                <Icon name="check" /> Approve {msgs.length === 1 ? "email" : `all ${msgs.length}`}
              </ConfirmButton>
            </form>
          )}
        </div>
        {msgs.map((r) => {
          const { m } = r;
          const v = (m.qaVerdict ?? {}) as Verdict;
          const facts = Object.entries(v.verdictFacts ?? {});
          return (
            <div key={m.id} className="step split">
              <div className="stack">
                <div className="row">
                  <span className="strong">Email {m.stepNumber}</span>
                  <span className="muted">{m.dayOffset === 0 ? "sends first" : `sends ${m.dayOffset} days later if no reply`}</span>
                  {isFlagged(r) && <Badge value="Flagged" tone="warn" />}
                </div>
                {v.issues && v.issues.length > 0 ? (
                  <ul className="flag-list small">
                    {v.issues.map((i, k) => (
                      <li key={k}>{i.message}</li>
                    ))}
                  </ul>
                ) : (
                  isFlagged(r) && <div className="muted small">Nothing wrong with this one; it waits with the rest of its sequence.</div>
                )}
                <div>
                  <div className="field-label">Subject</div>
                  <div className="strong">{m.subject}</div>
                </div>
                <EmailPreview body={m.body} mailbox={r.mb} config={ctx.config} />
                <div className="row">
                  <form action={approveMsg}>
                    <input type="hidden" name="id" value={m.id} />
                    <ConfirmButton className={canBulk ? "" : "primary"}>
                      <Icon name="check" /> Approve this email
                    </ConfirmButton>
                  </form>
                  <form action={rejectMsg} className="row">
                    <input type="hidden" name="id" value={m.id} />
                    <input name="reason" placeholder="Why reject? (optional)" style={{ minWidth: 200 }} aria-label="Reason for rejecting" />
                    <ConfirmButton className="danger-soft" confirm="Reject this email? The rest of this sequence stops too.">
                      Reject
                    </ConfirmButton>
                  </form>
                </div>
                <details>
                  <summary>Edit before approving</summary>
                  <form action={approveMsg} className="stack" style={{ marginTop: 10 }}>
                    <input type="hidden" name="id" value={m.id} />
                    {m.stepNumber === 1 && <input name="subject" defaultValue={m.subject} style={{ width: "100%" }} aria-label="Subject" />}
                    <textarea name="body" defaultValue={m.body} aria-label="Body" />
                    <div className="row">
                      <ConfirmButton className="primary">Save and approve</ConfirmButton>
                      <span className="muted small">Your edit is checked against the same rules before it is approved.</span>
                    </div>
                  </form>
                </details>
              </div>
              <aside className="stack">
                <div>
                  <div className="field-label">What this email claims, and where it came from</div>
                  {facts.length === 0 && m.proofPointIds.length === 0 ? (
                    <div className="muted">{v.personalized === false ? "Nothing personal. We had no researched facts for this company, so it uses general copy." : "No specific claims in this email."}</div>
                  ) : (
                    <ul className="plain claims">
                      {facts.map(([id, text]) => (
                        <li key={id}>
                          “{text}”
                          {v.factSources?.[id] && (
                            <div className="small" style={{ marginTop: 4 }}>
                              <a href={v.factSources[id]} target="_blank" rel="noreferrer">
                                Check on {host(v.factSources[id])} ↗
                              </a>
                            </div>
                          )}
                        </li>
                      ))}
                      {m.proofPointIds.map((id) => (
                        <li key={id}>
                          <Badge value="About us" tone="accent" /> {proof.get(id) ?? "(unknown proof point)"}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="meta-line">
                  <span>
                    {m.qaScore == null ? "Not scored: an earlier check stopped it before the reviewer read it" : <>Reviewer score <b>{m.qaScore}/100</b></>}
                  </span>
                </div>
              </aside>
            </div>
          );
        })}
      </article>
    );
  };

  return (
    <>
      <PageHeader
        icon="approvals"
        title="Approvals"
        actions={
          readyIds.length > 0 && (
            <form action={bulkApproveMsgs}>
              {readyIds.map((id) => (
                <input key={id} type="hidden" name="ids" value={id} />
              ))}
              <ConfirmButton className="primary" confirm={`Approve all ${readyIds.length} emails that passed review? Flagged ones are left for you.`}>
                <Icon name="check" /> Approve all {readyIds.length} ready
              </ConfirmButton>
            </form>
          )
        }
      />
      <PageTitle title="Approve emails">
        Emails that pass every check send by themselves, and a sequence the checks hold back is rewritten once with the reasons. What is still here after that needs a person: rewrite it again, edit and approve, or reject. (With approval of all turned on in Settings, every email waits here.)
      </PageTitle>
      <Flash ok={sp.ok} error={sp.error} />

      {groups.length === 0 ? (
        <Empty icon="approvals" title="Nothing to approve">
          New emails appear here as companies are researched and written to.
        </Empty>
      ) : (
        <>
          {flagged.length > 0 && (
            <Section title="Needs a closer look" count={flagged.length} sub="Flagged even after a rewrite. Rewrite again, edit the wording, or reject; they are not included in Approve all.">
              <div className="stack">{flagged.map((g) => thread(g, false))}</div>
            </Section>
          )}
          {ready.length > 0 && (
            <Section title="Ready to approve" count={ready.length} sub="Passed every check. Approve a whole sequence at once, or one email at a time.">
              <div className="stack">{ready.map((g) => thread(g, true))}</div>
            </Section>
          )}
        </>
      )}
    </>
  );
}
