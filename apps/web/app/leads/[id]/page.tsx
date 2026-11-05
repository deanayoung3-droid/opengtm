import { companies, contacts, facts, isSuppressed, mailboxes, meetings, messages, replies, threads } from "@opengtm/core";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Icon } from "../../../components/Icon";
import { Badge, Empty, Flash, PageHeader, Person, pretty, Section } from "../../../components/ui";
import { rebuildBriefAction } from "../../actions";
import { name, when } from "../../../lib/format";
import { EmailPreview } from "../../../components/EmailPreview";
import { rtReady } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [co] = await (await rtReady()).ctx.db.select({ name: companies.name }).from(companies).where(eq(companies.id, id));
  return { title: co?.name ?? "Lead" };
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "") + new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
};

export default async function Lead({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = (await rtReady());
  const [co] = await ctx.db.select().from(companies).where(eq(companies.id, id));
  if (!co) notFound();
  const [people, fs, ts] = await Promise.all([
    ctx.db.select().from(contacts).where(eq(contacts.companyId, id)),
    ctx.db.select().from(facts).where(eq(facts.companyId, id)).orderBy(asc(facts.createdAt)),
    ctx.db.select().from(threads).where(eq(threads.companyId, id)),
  ]);
  const threadIds = ts.map((t) => t.id);
  const senderIds = [...new Set(ts.map((t) => t.mailboxId).filter((x): x is string => !!x))];
  const senders = new Map((senderIds.length ? await ctx.db.select().from(mailboxes).where(inArray(mailboxes.id, senderIds)) : []).map((mb) => [mb.id, mb]));
  const [ms, rs] = threadIds.length
    ? await Promise.all([
        ctx.db.select().from(messages).where(inArray(messages.threadId, threadIds)).orderBy(asc(messages.stepNumber)),
        ctx.db.select().from(replies).where(inArray(replies.threadId, threadIds)).orderBy(desc(replies.receivedAt)),
      ])
    : [[], []];
  const [hot] = await ctx.db.select().from(meetings).where(eq(meetings.companyId, id)).orderBy(desc(meetings.createdAt)).limit(1);
  const brief = hot?.brief ?? null;
  const suppressed = new Map(await Promise.all(people.map(async (p) => [p.id, await isSuppressed(ctx.db, p.email)] as const)));

  return (
    <>
      <PageHeader icon="leads" parent={{ href: "/leads", label: "Leads" }} title={co.name} />

      <div className="page-title">
        <div className="row" style={{ gap: 10 }}>
          <h1>{co.name}</h1>
          <Badge value={co.status} />
        </div>
        <div className="meta-line" style={{ marginTop: 8, fontSize: 13 }}>
          <a href={co.website ?? `https://${co.domain}`} target="_blank" rel="noreferrer">
            <Icon name="globe" size={13} /> {co.domain}
          </a>
          {(co.city || co.state) && <span>{[co.city, co.state].filter(Boolean).join(", ")}</span>}
          <span>{co.companySize ? `${co.companySize} people` : "Size unknown"}</span>
          <span>{co.focusAreas.length ? co.focusAreas.map(pretty).join(", ") : "Focus unknown"}</span>
          <span>Source: {pretty(co.source)}</span>
        </div>
      </div>

      <Flash ok={sp.ok} error={sp.error} />

      {hot && (
        <section className="card brief">
          <div className="brief-head">
            <div>
              <h2>
                <Icon name="flame" size={16} /> Demo prep
              </h2>
              <p className="muted small">{brief ? `Written ${when(hot.briefAt ?? hot.updatedAt)} from what we found and the conversation. Check anything important before the call.` : "This lead is hot. Write a one-page prep for the demo."}</p>
            </div>
            <form action={rebuildBriefAction}>
              <input type="hidden" name="id" value={hot.id} />
              <input type="hidden" name="company" value={co.id} />
              <button type="submit" className="btn sm">
                <Icon name="sparkle" size={14} /> {brief ? "Rebuild" : "Write demo prep"}
              </button>
            </form>
          </div>
          {brief && (
            <>
              <p className="brief-headline">{brief.headline}</p>
              <div className="brief-grid">
                <div>
                  <h3>The person</h3>
                  <ul>{brief.person.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  <h3>The company</h3>
                  <ul>
                    {brief.company.map((x, i) => (
                      <li key={i}>
                        {x.text}{" "}
                        {x.source && (
                          <a href={x.source} target="_blank" rel="noreferrer" className="muted small">
                            source
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                  <h3>Using today</h3>
                  <p>{brief.currentTools ?? "Unknown: ask on the call."}</p>
                </div>
                <div>
                  <h3>Show them</h3>
                  <ul>
                    {brief.showThem.map((x, i) => (
                      <li key={i}>
                        <b>{x.feature}</b>: {x.why}
                      </li>
                    ))}
                  </ul>
                  <h3>Ask them</h3>
                  <ul>{brief.questions.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  {brief.watchOuts.length > 0 && (
                    <>
                      <h3>Watch out for</h3>
                      <ul>{brief.watchOuts.map((x, i) => <li key={i}>{x}</li>)}</ul>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      )}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        <div className="card metric">
          <div className="label">
            <Icon name="sparkle" /> ICP fit
          </div>
          <div className="value">{co.icpScore ?? "-"}</div>
          <div className="meter">
            <span style={{ width: `${co.icpScore ?? 0}%` }} />
          </div>
          <div className="sub">{co.icpReason}</div>
        </div>
        <div className="card metric">
          <div className="label">
            <Icon name="layers" /> Segment
          </div>
          <div className="value" style={{ fontSize: 18, marginTop: 12 }}>
            {pretty(co.segmentId)}
          </div>
          {co.signals.length > 0 && (
            <div className="row" style={{ marginTop: 10 }}>
              {co.signals.map((s) => (
                <Badge key={s} value={s} tone="accent" />
              ))}
            </div>
          )}
        </div>
        <div className="card metric">
          <div className="label">
            <Icon name="file" /> Researched facts
          </div>
          <div className="value">{fs.length}</div>
          <div className="sub">{fs.length ? "Every personal line cites one of these." : "Emails use segment-level copy."}</div>
        </div>
      </div>

      <Section title="Contacts" count={people.length}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Status</th>
                <th>Verified</th>
                <th>Mail provider</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Person name={name(p)} meta={p.title} />
                  </td>
                  <td>{p.email}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <Badge value={p.status} />
                      {suppressed.get(p.id) && <Badge value="suppressed" />}
                    </div>
                    {p.dropReason && <div className="small muted" style={{ marginTop: 4 }}>{p.dropReason}</div>}
                  </td>
                  <td>{pretty(p.verifyStatus)}</td>
                  <td>{pretty(p.mailProvider)}</td>
                  <td className="small">
                    {pretty(p.source)}
                    {p.sourceUrl && (
                      <div>
                        <a href={p.sourceUrl} target="_blank" rel="noreferrer">
                          {host(p.sourceUrl)} ↗
                        </a>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Facts" count={fs.length}>
        {fs.length === 0 ? (
          <Empty icon="file" title="No facts stored">
            Emails to this company use segment-level copy with no personal claims.
          </Empty>
        ) : (
          <ul className="plain claims">
            {fs.map((f) => (
              <li key={f.id}>
                <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                  <Badge value={f.kind} />
                  <div>
                    <div style={{ color: "var(--ink)" }}>{f.text}</div>
                    <div className="small muted" style={{ marginTop: 3 }}>
                      <a href={f.sourceUrl} target="_blank" rel="noreferrer">
                        {host(f.sourceUrl)} ↗
                      </a>{" "}
                      · fetched {when(f.fetchedAt)}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Email threads" count={ts.length}>
        {ts.length === 0 && (
          <Empty icon="mailboxes" title="Not enrolled">
            This company hasn't been added to a sequence yet.
          </Empty>
        )}
        <div className="stack">
          {ts.map((t) => (
            <div key={t.id} className="card flush">
              <div className="card-head">
                <span className="strong">Variant {t.variant}</span>
                <Badge value={t.status} />
                {t.stopReason && <span className="small muted">{t.stopReason}</span>}
                {t.pausedUntil && <span className="small muted">Paused until {when(t.pausedUntil)}</span>}
              </div>
              <div className="card-body stack">
                {ms
                  .filter((m) => m.threadId === t.id)
                  .map((m) => (
                    <details key={m.id}>
                      <summary>
                        <span style={{ color: "var(--ink)" }}>{m.kind === "reply" ? "Reply" : `Step ${m.stepNumber}`}</span>
                        <span style={{ fontWeight: 400 }}>{m.subject}</span>
                        <Badge value={m.status} />
                        <span className="small muted" style={{ fontWeight: 400 }}>
                          {m.sentAt ? `Sent ${when(m.sentAt)}` : m.scheduledFor ? `Scheduled ${when(m.scheduledFor)}` : pretty(m.approvalState)}
                        </span>
                      </summary>
                      <div style={{ marginTop: 10 }}>
                        <EmailPreview body={m.body} mailbox={senders.get(m.mailboxId ?? t.mailboxId ?? "")} config={ctx.config} />
                      </div>
                    </details>
                  ))}
                {rs
                  .filter((r) => r.threadId === t.id)
                  .map((r) => (
                    <div key={r.id} className="notice" style={{ margin: 0 }}>
                      <Icon name="reply" />
                      <div>
                        <div className="row" style={{ marginBottom: 4 }}>
                          <Badge value={r.label ?? "unclassified"} />
                          <span className="small muted">{when(r.receivedAt)}</span>
                        </div>
                        {r.body.slice(0, 300)}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
