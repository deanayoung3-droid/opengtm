import { DAY, sequences, sequenceSteps } from "@opengtm/core";
import { replySources, segmentFunnel, stepVariantStats, variantStats } from "@opengtm/learning";
import { asc } from "drizzle-orm";
import Link from "next/link";
import { Segmented } from "../../components/Segmented";
import { ConfirmButton } from "../../components/ConfirmButton";
import { Badge, Empty, Flash, PageHeader, PageTitle, pretty, Section } from "../../components/ui";
import { pct, usd } from "../../lib/format";
import { rtReady } from "../../lib/runtime";
import { saveCampaignAction, segmentStatus, variantAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaigns" };

const SOURCE_NAMES: Record<string, string> = { ai_ark: "AI Ark", csv: "CSV import", site: "Company websites", referral: "Referrals" };

export default async function Campaigns({ searchParams }: { searchParams: Promise<{ range?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const range = sp.range === "7d" || sp.range === "30d" ? sp.range : "all";
  const since = range === "all" ? undefined : new Date(Date.now() - (range === "7d" ? 7 : 30) * DAY);
  const { ctx } = (await rtReady());
  const [funnel, sources, steps, seqs, stepRows] = await Promise.all([
    segmentFunnel(ctx, since),
    replySources(ctx, since),
    stepVariantStats(ctx, since),
    ctx.db.select().from(sequences),
    ctx.db.select().from(sequenceSteps).orderBy(asc(sequenceSteps.variant), asc(sequenceSteps.stepNumber)),
  ]);
  const vstats = new Map(await Promise.all(seqs.map(async (s) => [s.id, await variantStats(ctx, s.id)] as const)));
  const describe = new Map(ctx.config.business.icp.segments.map((s) => [s.id, s.description]));

  return (
    <>
      <PageHeader
        icon="campaigns"
        title="Campaigns"
        actions={
          <Segmented as="nav" className="tabs" aria-label="Date range">
            {["all", "30d", "7d"].map((r) => (
              <Link key={r} href={`/campaigns?range=${r}`} className={r === range ? "on" : ""} aria-current={r === range ? "page" : undefined}>
                {r === "all" ? "All time" : `Last ${r.replace("d", " days")}`}
              </Link>
            ))}
          </Segmented>
        }
      />
      <PageTitle title="Segments and variants">Every stage from sourced lead to won deal, per segment. Segments pause themselves after 150 sends with no positive reply.</PageTitle>

      <Flash ok={sp.ok} error={sp.error} />

      <Section title="Campaigns" count={ctx.config.business.icp.segments.length} sub="Each campaign is a kind of company. Keywords decide which companies the lead search finds; the description tells the writer who they are.">
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
          {ctx.config.business.icp.segments.map((seg) => {
            const f = funnel.find((x) => x.segmentId === seg.id);
            return (
              <form key={seg.id} id={seg.id} action={saveCampaignAction} className="card stack">
                <input type="hidden" name="id" value={seg.id} />
                <div className="row">
                  <span className="strong" style={{ flex: 1 }}>{pretty(seg.id)}</span>
                  {f?.status === "paused" ? <Badge value="paused" /> : <Badge value="active" dot />}
                </div>
                <label className="field">
                  <span>Who they are</span>
                  <input name="description" defaultValue={seg.description} />
                </label>
                <label className="field">
                  <span>Keywords</span>
                  <input name="keywords" defaultValue={seg.keywords.join(", ")} />
                </label>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="small muted">{f ? `${f.emailed} emailed · ${f.replied} replied · ${f.positive} positive` : "No sends yet"}</span>
                  <ConfirmButton className="sm">Save</ConfirmButton>
                </div>
              </form>
            );
          })}
          <form id="new" action={saveCampaignAction} className="card stack" style={{ background: "var(--surface-2)" }}>
            <span className="strong">New campaign</span>
            <label className="field">
              <span>Name</span>
              <input name="name" placeholder="e.g. Workers' comp companies" required />
            </label>
            <label className="field">
              <span>Who they are</span>
              <input name="description" placeholder="Small workers' compensation companies" />
            </label>
            <label className="field">
              <span>Keywords</span>
              <input name="keywords" placeholder="workers compensation, work injury" required />
            </label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <ConfirmButton className="primary sm">Create campaign</ConfirmButton>
            </div>
          </form>
        </div>
      </Section>

      <Section title="Funnel by segment" count={funnel.length}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Segment</th>
                <th className="num">Sourced</th>
                <th className="num">Verified</th>
                <th className="num">Emailed</th>
                <th className="num">Replied</th>
                <th className="num">Positive</th>
                <th className="num">Booked</th>
                <th className="num">Held</th>
                <th className="num">Won</th>
                <th className="num">Positive rate</th>
                <th className="num">Spend</th>
                <th className="num">Per meeting</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {funnel.map((f) => (
                <tr key={f.segmentId}>
                  <td style={{ minWidth: 260 }}>
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      <span className="primary">{pretty(f.segmentId)}</span>
                      {f.status === "paused" && <Badge value="paused" />}
                    </div>
                    <div className="small muted">{describe.get(f.segmentId)}</div>
                  </td>
                  <td className="num">{f.sourced}</td>
                  <td className="num">{f.verified}</td>
                  <td className="num">{f.emailed}</td>
                  <td className="num">{f.replied}</td>
                  <td className="num">{f.positive}</td>
                  <td className="num">{f.booked}</td>
                  <td className="num">{f.held}</td>
                  <td className="num">{f.won}</td>
                  <td className="num">{pct(f.positiveRate)}</td>
                  <td className="num">{usd(f.costUsd)}</td>
                  <td className="num">{usd(f.costPerMeeting)}</td>
                  <td style={{ textAlign: "right" }}>
                    <form action={segmentStatus}>
                      <input type="hidden" name="id" value={f.segmentId} />
                      <input type="hidden" name="status" value={f.status === "paused" ? "active" : "paused"} />
                      <ConfirmButton className="sm" confirm={f.status === "paused" ? "Resume this segment?" : "Pause this segment? Scheduled emails will wait."}>
                        {f.status === "paused" ? "Resume" : "Pause"}
                      </ConfirmButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Where real replies come from"
        count={sources.length}
        sub="Per lead source and kind of person: real replies are people who wrote back themselves; auto-replies are away notices and 'moved / no longer here'. Buy more of what gets real replies."
      >
        {sources.length === 0 ? (
          <Empty title="No emails sent in this range yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lead source</th>
                  <th>Who</th>
                  <th className="num">Emailed</th>
                  <th className="num">Real replies</th>
                  <th className="num">Positive</th>
                  <th className="num">Auto-replies</th>
                  <th className="num">Bounced</th>
                  <th className="num">Real per 100</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={`${s.source}|${s.who}`}>
                    <td className="primary">{SOURCE_NAMES[s.source] ?? pretty(s.source)}</td>
                    <td>{s.who === "role_address" ? "info@-style address" : s.who === "other" ? "Other title" : pretty(s.who)}</td>
                    <td className="num">{s.emailed}</td>
                    <td className="num">{s.real}</td>
                    <td className="num">{s.positive}</td>
                    <td className="num">{s.auto}</td>
                    <td className="num">{s.bounced}</td>
                    <td className="num">{s.emailed ? ((100 * s.real) / s.emailed).toFixed(1) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Step and variant performance">
        {steps.length === 0 ? (
          <Empty icon="send" title="No sends yet">
            Reply rates per step and variant show up after the first emails go out.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Segment</th>
                  <th className="num">Step</th>
                  <th>Variant</th>
                  <th className="num">Sends</th>
                  <th className="num">Replies</th>
                  <th className="num">Positive</th>
                  <th className="num">Reply rate</th>
                  <th className="num">Copy cost</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((s) => (
                  <tr key={`${s.segmentId}${s.step}${s.variant}`}>
                    <td className="primary">{pretty(s.segmentId)}</td>
                    <td className="num">{s.step}</td>
                    <td>{s.variant}</td>
                    <td className="num">{s.sends}</td>
                    <td className="num">{s.replies}</td>
                    <td className="num">{s.positive}</td>
                    <td className="num">{pct(s.sends ? s.replies / s.sends : 0)}</td>
                    <td className="num">{usd(s.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {seqs.map((seq) => {
        const variants = [...new Set(stepRows.filter((r) => r.sequenceId === seq.id).map((r) => r.variant))];
        const stats = vstats.get(seq.id) ?? [];
        return (
          <Section key={seq.id} title={`Sequence: ${seq.name}`} sub="Two variants run per step. The winner is kept once the difference is significant, and the model proposes a new challenger.">
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
              {variants.map((v) => {
                const rows = stepRows.filter((r) => r.sequenceId === seq.id && r.variant === v);
                const status = rows[0]?.status ?? "active";
                const st = stats.find((x) => x.variant === v);
                return (
                  <div key={v} className="card flush">
                    <div className="card-head">
                      <span className="strong">Variant {v}</span>
                      <Badge value={status} />
                      {st && (
                        <span className="small muted">
                          {st.threads} threads · {st.positive} positive · {pct(st.rate)}
                        </span>
                      )}
                    </div>
                    <div className="card-body">
                      <ol className="timeline">
                        {rows.map((r) => (
                          <li key={r.id}>
                            <div className="day">Day {r.dayOffset}</div>
                            {r.instructions}
                          </li>
                        ))}
                      </ol>
                    </div>
                    {status === "proposed" && (
                      <div className="card-foot">
                        <form action={variantAction} className="row">
                          <input type="hidden" name="sequenceId" value={seq.id} />
                          <input type="hidden" name="variant" value={v} />
                          <ConfirmButton className="primary sm" name="action" value="activate" confirm="Start testing this variant?">
                            Start testing
                          </ConfirmButton>
                          <ConfirmButton className="sm" name="action" value="reject">
                            Reject
                          </ConfirmButton>
                        </form>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        );
      })}
    </>
  );
}
