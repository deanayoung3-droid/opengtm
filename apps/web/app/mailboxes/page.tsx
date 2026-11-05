import { DAY, domains, mailboxes, seedTests, teamDay } from "@opengtm/core";
import { seedPlacementByMailbox } from "@opengtm/health";
import { dailyCap } from "@opengtm/sequencer";
import { asc, desc } from "drizzle-orm";
import { ConfirmButton } from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { Badge, Empty, Flash, Metric, PageHeader, PageTitle, pretty, Section } from "../../components/ui";
import { ago, pct, when } from "../../lib/format";
import { rtReady } from "../../lib/runtime";
import { signatureHtml } from "@opengtm/writer";
import { importInboxesAction, mailboxAction, mailboxSignatureAction, mailboxTestEmailAction, renameInboxesAction, signatureTitleAllAction, uniqueNamesAction } from "../actions";
import { APP_NAME } from "../../lib/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Channels" };

const dnsChip = (label: string, ok: boolean | null) => <Badge key={label} value={label} tone={ok === null ? "" : ok ? "good" : "bad"} />;

export default async function Mailboxes({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const { ctx } = (await rtReady());
  const now = new Date();
  const [mbs, doms, seeds, placement] = await Promise.all([
    ctx.db.select().from(mailboxes).orderBy(asc(mailboxes.email)),
    ctx.db.select().from(domains).orderBy(asc(domains.name)),
    ctx.db.select().from(seedTests).orderBy(desc(seedTests.sentAt)).limit(30),
    seedPlacementByMailbox(ctx, new Date(now.getTime() - 14 * DAY)),
  ]);
  const mbEmail = new Map(mbs.map((m) => [m.id, m.email]));
  const active = mbs.filter((m) => m.status === "active");
  const capToday = active.reduce((s, m) => s + dailyCap(m, now, ctx.config.engine.ramp), 0);
  const sentToday = mbs.reduce((s, m) => s + (m.sentTodayDate === teamDay(now) ? m.sentToday : 0), 0);
  const placed = [...placement.values()].reduce((a, p) => ({ inbox: a.inbox + p.inbox, total: a.total + p.total }), { inbox: 0, total: 0 });
  const h = ctx.config.engine.health;

  return (
    <>
      <PageHeader icon="mailboxes" title="Channels" />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="grid fit" style={{ marginBottom: 24 }}>
        <div className="card stack tight">
          <div className="row">
            <Icon name="mailboxes" />
            <span className="strong" style={{ flex: 1 }}>Email</span>
            <Badge value={active.length ? "On" : "No mailboxes"} tone={active.length ? "good" : "warn"} dot />
          </div>
          <div className="small muted">{active.length} of {mbs.length} mailboxes sending. Each sends as its own sender name, within the daily limits below.</div>
        </div>
        <div className="card stack tight">
          <div className="row">
            <Icon name="user" />
            <span className="strong" style={{ flex: 1 }}>LinkedIn</span>
            <Badge value="Not included" />
          </div>
          <div className="small muted">{APP_NAME} sends email only. LinkedIn automation risks the team's own accounts, so it's left out on purpose.</div>
        </div>
      </div>
      <PageTitle title="Mailboxes and domains">
        Each mailbox ramps up slowly and pauses itself at {h.max_bounce_rate * 100}% bounces. Domains pause at {h.max_complaint_rate * 100}% complaints, and anything placing under {h.min_seed_placement * 100}% in the inbox is retired.
      </PageTitle>

      <div className="grid fit">
        <Metric icon="mailboxes" label="Active mailboxes" value={`${active.length} / ${mbs.length}`} sub={`${mbs.length - active.length} paused, warming or retired`} />
        <Metric icon="send" label="Sending capacity today" value={sentToday} meter={{ value: sentToday, max: capToday }} sub={`of ${capToday} across active mailboxes`} />
        <Metric icon="shield" label="Inbox placement" value={placed.total ? pct(placed.inbox / placed.total) : "-"} sub={placed.total ? `${placed.inbox} of ${placed.total} seed emails, 14 days` : "No seed tests yet"} />
        <Metric icon="globe" label="Sending domains" value={doms.length} sub={`${doms.filter((d) => d.status === "active").length} active`} />
      </div>

      <Section title="Mailboxes" count={mbs.length}>
        {mbs.length === 0 ? (
          <Empty icon="mailboxes" title="No mailboxes yet">
            Import your inboxes below with the CSV from your mailbox vendor.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Status</th>
                  <th className="num">Health</th>
                  <th>Today</th>
                  <th className="num">Ramp week</th>
                  <th className="num">Inbox rate</th>
                  <th>Last checked</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mbs.map((m) => {
                  const sent = m.sentTodayDate === teamDay(now) ? m.sentToday : 0;
                  const cap = dailyCap(m, now, ctx.config.engine.ramp);
                  const week = Math.max(1, Math.floor((now.getTime() - m.rampStartDate.getTime()) / (7 * DAY)) + 1);
                  const p = placement.get(m.id);
                  return (
                    <tr key={m.id}>
                      <td>
                        <div className="primary">{m.email}</div>
                        <div className="small muted">
                          {m.senderName} · {pretty(m.provider)} · {m.transport}
                        </div>
                      </td>
                      <td>
                        <Badge value={m.status} dot />
                        {m.pausedReason && <div className="small muted" style={{ marginTop: 4, maxWidth: 220 }}>{m.pausedReason}</div>}
                      </td>
                      <td className="num">{m.healthScore}</td>
                      <td style={{ minWidth: 120 }}>
                        <div className="num small">
                          {sent} / {cap}
                        </div>
                        <div className="meter" style={{ marginTop: 6 }}>
                          <span style={{ width: `${cap ? Math.min(100, (sent / cap) * 100) : 0}%` }} />
                        </div>
                      </td>
                      <td className="num">{week}</td>
                      <td className="num">{p ? `${pct(p.inbox / p.total)}` : "-"}</td>
                      <td className="small muted">{ago(m.lastIngestAt, now)}</td>
                      <td>
                        <form action={mailboxAction} className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                          <input type="hidden" name="id" value={m.id} />
                          {m.status === "active" && (
                            <ConfirmButton className="sm" name="action" value="pause" confirm="Pause this mailbox?">
                              Pause
                            </ConfirmButton>
                          )}
                          {m.status === "paused" && (
                            <ConfirmButton className="sm" name="action" value="resume" confirm="Resume sending from this mailbox?">
                              Resume
                            </ConfirmButton>
                          )}
                          {m.status !== "retired" && (
                            <ConfirmButton className="sm danger-soft" name="action" value="retire" confirm="Retire permanently? Its threads will wait until reassigned.">
                              Retire
                            </ConfirmButton>
                          )}
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        id="import"
        title="Add inboxes"
        sub="Upload the inbox list from your mailbox vendor: one inbox per line with its email address and app password. Server and name columns are optional; Google's servers are used if missing, and the sender name comes from the name columns or the address. Each login is tested before anything is saved, nothing is sent, and passwords are stored encrypted. New inboxes start at 15 emails a day and ramp up. Uploading an inbox that's already here only replaces its password."
      >
        <form action={importInboxesAction} className="card stack">
          <label className="field">
            <span>CSV file</span>
            <input type="file" name="file" accept=".csv,text/csv,text/plain" />
          </label>
          <label className="field">
            <span>Or paste it</span>
            <textarea name="csv" rows={4} placeholder={"email,app password,first name,last name\nalex@outreach-example.com,abcd efgh ijkl mnop,Alex,Lee"} spellCheck={false} autoComplete="off" />
          </label>
          <div className="row">
            <ConfirmButton className="primary sm">Import inboxes</ConfirmButton>
            <span className="small muted">Takes a few seconds per inbox while each login is tested.</span>
          </div>
        </form>
        <form action={renameInboxesAction} className="card stack" style={{ marginTop: 16 }}>
          <label className="field">
            <span>Renamed an address at the vendor? One per line: old address, new address</span>
            <textarea name="renames" rows={3} placeholder={"mary@outreach-example.com, alex@outreach-example.com"} spellCheck={false} autoComplete="off" />
          </label>
          <div className="row">
            <ConfirmButton className="sm">Rename inboxes</ConfirmButton>
            <span className="small muted">Same inbox, new address: it keeps its ramp, emails and password, and sends as the new name.</span>
          </div>
        </form>
      </Section>

      {mbs.some((m) => m.status !== "retired") && (
        <Section title="Signatures" sub="Every email ends with the sending mailbox's signature, like a Gmail signature: name, title and phone, and your logo if you set one. Changes apply to the next email sent, including ones already written.">
          <form action={signatureTitleAllAction} className="row" style={{ marginBottom: 16, alignItems: "flex-end" }}>
            <label className="field" style={{ flex: 1, maxWidth: 360 }}>
              <span>Title for every inbox</span>
              <input name="title" placeholder="e.g. Partnerships" maxLength={60} />
            </label>
            <ConfirmButton className="sm" confirm="Put this title on every inbox's signature?">
              Apply to all
            </ConfirmButton>
            <ConfirmButton className="sm" formAction={uniqueNamesAction} confirm="Give each inbox that shares a name, and hasn't emailed anyone yet, its own last name?">
              Give every inbox its own name
            </ConfirmButton>
          </form>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {mbs
              .filter((m) => m.status !== "retired")
              .map((m) => (
                <form key={m.id} action={mailboxSignatureAction} className="card stack">
                  <input type="hidden" name="id" value={m.id} />
                  <div className="small muted">{m.email}</div>
                  <div
                    className="signature-preview"
                    // Built from escaped mailbox fields by signatureHtml; the logo is an embedded image.
                    dangerouslySetInnerHTML={{ __html: signatureHtml({ name: m.senderName, title: m.senderTitle, phone: m.senderPhone }, ctx.config, "data") }}
                  />
                  <label className="field">
                    <span>Title</span>
                    <input name="title" defaultValue={m.senderTitle ?? ""} placeholder="e.g. Partnerships" maxLength={60} />
                  </label>
                  <label className="field">
                    <span>Phone (shown as &ldquo;C: ...&rdquo;)</span>
                    <input name="phone" defaultValue={m.senderPhone ?? ""} placeholder="+1 (555) 123-4567" inputMode="tel" maxLength={30} />
                  </label>
                  <div className="row">
                    <button type="submit" className="sm">
                      Save signature
                    </button>
                    <button type="submit" className="sm" formAction={mailboxTestEmailAction}>
                      Email me a test
                    </button>
                  </div>
                </form>
              ))}
          </div>
        </Section>
      )}

      <Section title="Domains" count={doms.length}>
        {doms.length === 0 ? (
          <Empty icon="globe" title="No sending domains yet">
            Domains are added with their first mailbox.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>DNS</th>
                  <th>Last checked</th>
                </tr>
              </thead>
              <tbody>
                {doms.map((d) => (
                  <tr key={d.id}>
                    <td className="primary">{d.name}</td>
                    <td>
                      <Badge value={d.status} dot />
                      {d.pausedReason && <div className="small muted" style={{ marginTop: 4 }}>{d.pausedReason}</div>}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {dnsChip("SPF", d.spfOk)}
                        {dnsChip("DKIM", d.dkimOk)}
                        {dnsChip("DMARC", d.dmarcOk)}
                      </div>
                      <div className="small muted" style={{ marginTop: 6 }}>
                        Recheck: <code>pnpm gtm dns-check {d.name}</code>
                      </div>
                    </td>
                    <td className="small muted">{when(d.lastCheckedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Recent seed tests" count={seeds.length} sub="Weekly test sends to inboxes we own on Gmail and Outlook, to see whether mail lands in the inbox or spam.">
        {seeds.length === 0 ? (
          <Empty icon="shield" title="No seed tests yet">
            Add seed inboxes under <code>health.seed_inboxes</code> in <code>config/engine.yaml</code>.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Seed inbox</th>
                  <th>Landed in</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {seeds.map((s) => (
                  <tr key={s.id}>
                    <td className="primary">{mbEmail.get(s.mailboxId)}</td>
                    <td>{s.seedInbox}</td>
                    <td>
                      <Badge value={s.placement} tone={s.placement === "inbox" ? "good" : s.placement === "pending" ? "" : "bad"} />
                    </td>
                    <td className="small muted">{when(s.sentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
