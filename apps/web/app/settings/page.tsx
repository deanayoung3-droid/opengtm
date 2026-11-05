import { TEAM_TZ_LABEL, AUTO_REPLY_DELAYS, auditLog, DECISION_TASKS, events, getAutoReply, getForceApproval, humanTodos, isKillSwitchOn, listMembers, mailboxes, NOTIFY_KINDS, TASKS } from "@opengtm/core";
import { asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { AutoSubmitInput, AutoSubmitSelect, AutoSubmitToggle } from "../../components/AutoSubmit";
import { ConfirmButton } from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { Badge, Empty, Flash, initials, PageHeader, PageTitle, pretty, Section } from "../../components/ui";
import { clock, sendDaysText, when } from "../../lib/format";
import { rtReady } from "../../lib/runtime";
import { setAutoReplyAction, setForceApproval, setNotifyAction, toggleKill } from "../actions";
import { APP_NAME } from "../../lib/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

const delayLabel = (m: number) => (m < 60 ? `${m}m` : `${m / 60}h`);

export default async function Settings({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const { ctx, verifier } = (await rtReady());
  const cfg = ctx.config;
  const autoReply = await getAutoReply(ctx.db, cfg.engine.replies.auto_reply);
  const [killed, force, digest, log, team, [sender]] = await Promise.all([
    isKillSwitchOn(ctx.db),
    getForceApproval(ctx.db),
    ctx.db.select().from(events).where(eq(events.type, "digest")).orderBy(desc(events.createdAt)).limit(1),
    ctx.db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(30),
    listMembers(ctx.db),
    ctx.db.select({ email: mailboxes.email }).from(mailboxes).where(eq(mailboxes.status, "active")).orderBy(asc(mailboxes.createdAt)).limit(1),
  ]);
  const todos = humanTodos(cfg);
  const env = ctx.env;
  const p = cfg.llm.providers;
  const providerOk: Record<string, boolean> = {
    anthropic: !!(p.anthropic && env[p.anthropic.api_key_env]),
    openai: !!(p.openai && env[p.openai.api_key_env]),
    gemini: !!(p.gemini && env[p.gemini.api_key_env]),
    local: !!(p.local && env[p.local.base_url_env]),
    jev: !!(p.jev && env[p.jev.api_key_env]),
  };
  const e = cfg.engine;
  const ark = e.leads.ai_ark;
  const approvalMode = force === null ? (e.approval.force_all ? "all" : "policy") : force ? "all" : "policy";

  return (
    <>
      <PageHeader icon="settings" title="Settings" />
      <PageTitle title="Settings">Controls, guardrails and what the engine is configured to do. Config lives in <code>config/*.yaml</code>; changes there take effect on restart.</PageTitle>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <div className="card stack">
          <div className="row">
            <Icon name="power" />
            <h3>Kill switch</h3>
            <span style={{ marginLeft: "auto" }}>{killed ? <Badge value="Stopped" tone="bad" dot /> : <Badge value="Off" tone="good" dot />}</span>
          </div>
          <div className="muted">Stops every send immediately, from every mailbox. Replies are still read.</div>
          <form action={toggleKill} className="row">
            <input type="hidden" name="on" value={killed ? "false" : "true"} />
            <input type="hidden" name="from" value="/settings" />
            <input name="reason" placeholder="Reason (for the audit log)" style={{ flex: 1, minWidth: 160 }} aria-label="Reason" />
            <ConfirmButton className={killed ? "primary" : "danger"} confirm={killed ? "Resume sending?" : "Stop all sending?"}>
              {killed ? "Resume sending" : "Stop all sending"}
            </ConfirmButton>
          </form>
          <div className="small muted">
            Also from the server terminal: <code>node dist/cli.mjs kill on</code>
          </div>
        </div>
        <div className="card stack">
          <div className="row">
            <Icon name="approvals" />
            <h3>Outreach emails</h3>
            <span style={{ marginLeft: "auto" }}>
              <Badge value={approvalMode === "all" ? "Approve every email" : "Autopilot"} tone={approvalMode === "all" ? "warn" : "good"} dot />
            </span>
          </div>
          <div className="muted">
            {approvalMode === "all"
              ? "A person approves every email on Approvals before it goes out."
              : `Autopilot: emails that pass every check send by themselves on schedule. Anything the checker flags waits on Approvals${e.approval.require_first_n ? `, as do the first ${e.approval.require_first_n}` : ""}${e.approval.sample_rate ? `, plus a ${Math.round(e.approval.sample_rate * 100)}% random sample` : ""}.`}
            {force !== null && ` (Set here; the config default is ${e.approval.force_all ? "approve every email" : "autopilot"}.)`}
          </div>
          <form action={setForceApproval} className="row">
            <ConfirmButton className={approvalMode === "policy" ? "primary" : ""} name="value" value="off">
              Autopilot
            </ConfirmButton>
            <ConfirmButton className={approvalMode === "all" ? "primary" : ""} name="value" value="on">
              Approve every email
            </ConfirmButton>
            {force !== null && (
              <ConfirmButton name="value" value="config">
                Reset to config
              </ConfirmButton>
            )}
          </form>
        </div>
        <div className="card stack">
          <div className="row">
            <Icon name="reply" />
            <h3>Replies to leads</h3>
            <span style={{ marginLeft: "auto" }}>
              <Badge value={autoReply.enabled ? "Automatic" : "Manual"} tone={autoReply.enabled ? "good" : "neutral"} dot />
            </span>
          </div>
          <div className="muted">
            {autoReply.enabled
              ? `Every reply gets a draft right away. ${autoReply.delayMinutes ? `It waits ${delayLabel(autoReply.delayMinutes)} for anyone to edit, send or hold it, then` : "It"} sends by itself. Hot leads and unclear replies always wait for a person, and the team gets an email.`
              : "Every reply gets a draft right away; nothing is sent until someone sends it from the inbox."}
          </div>
          <form action={setAutoReplyAction} className="row">
            <label className="row" style={{ gap: 8 }}>
              <AutoSubmitToggle name="enabled" defaultChecked={autoReply.enabled} aria-label="Reply automatically" />
              <span>Reply automatically</span>
            </label>
            <AutoSubmitSelect name="delay" defaultValue={String(autoReply.delayMinutes)} aria-label="After how long" disabled={!autoReply.enabled}>
              {AUTO_REPLY_DELAYS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "instantly" : `after ${delayLabel(m)} review`}
                </option>
              ))}
            </AutoSubmitSelect>
          </form>
        </div>
      </div>

      <Section
        id="notifications"
        title="Email notifications"
        sub={`Who gets an email when something happens, delivered to the address in "Send to". Sent as "${APP_NAME}" from ${sender?.email ?? "your first active mailbox"}, each with a link to the conversation.`}
      >
        {team.length === 0 ? (
          <Empty icon="mail" title="Nobody to notify yet">
            People appear here once they're on the Team page. On your laptop the login skips the workspace, so this list fills in on the server.
          </Empty>
        ) : (
          <div className="card flush notify-table">
            <div className="notify-row head">
              <span>Person</span>
              {NOTIFY_KINDS.map((k) => (
                <span key={k.kind} title={k.hint}>
                  {k.label}
                </span>
              ))}
            </div>
            {team.map((m) => (
              <form key={m.id} action={setNotifyAction} className="notify-row">
                <input type="hidden" name="id" value={m.id} />
                <span className="person">
                  <span className="avatar">{initials(m.name || m.email)}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="name">{m.name || m.email}</span>
                    <label className="send-to">
                      <span>Send to</span>
                      <AutoSubmitInput name="alert_email" type="email" defaultValue={m.alertEmail ?? m.email} aria-label={`Alert email for ${m.name || m.email}`} />
                    </label>
                  </span>
                </span>
                {NOTIFY_KINDS.map((k) => (
                  <label key={k.kind} className="switch-cell" title={k.hint}>
                    <AutoSubmitToggle name={k.kind} defaultChecked={m.notify[k.kind]} aria-label={`${k.label} emails for ${m.name || m.email}`} />
                  </label>
                ))}
              </form>
            ))}
          </div>
        )}
        <p className="small muted" style={{ marginTop: 8 }}>
          {NOTIFY_KINDS.map((k) => `${k.label}: ${k.hint.toLowerCase()}.`).join(" ")}
        </p>
      </Section>

      <Section title="Setup checklist" count={todos.length} sub="Things only a person can provide (config/business.yaml and engine.yaml).">
        {todos.length === 0 ? (
          <Empty icon="check" title="Everything is filled in" />
        ) : (
          <div className="card flush">
            <ul className="plain todo">
              {todos.map((t) => (
                <li key={t.field}>
                  <Badge value={t.blocksSending ? "Blocks sending" : "To do"} tone={t.blocksSending ? "bad" : "warn"} />
                  <div>
                    <code>{t.field}</code>
                    <div className="muted" style={{ marginTop: 3 }}>{t.note}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="Guardrails and limits">
        <div className="table-wrap">
          <table className="kv">
            <tbody>
              <tr><td>Daily send cap</td><td>{e.caps.daily_send_cap} emails</td></tr>
              <tr><td>Daily spend cap</td><td>${e.caps.daily_spend_cap_usd}</td></tr>
              <tr><td>Model spend per lead</td><td>${e.caps.per_lead_llm_cap_usd} max</td></tr>
              <tr><td>Mailbox ramp</td><td>{e.ramp.tiers.map((t) => `week ${t.from_week}+: ${t.per_day}/day`).join(" · ")} (never above {e.ramp.hard_max_per_day})</td></tr>
              <tr><td>Sending window</td><td>{clock(e.timing.business_start)} to {clock(e.timing.business_end)} in the recipient's time zone, {sendDaysText(e.timing)}, {e.timing.jitter_min_s}-{e.timing.jitter_max_s}s between sends. <Link href="/schedule">Full schedule</Link></td></tr>
              <tr><td>Auto-pause</td><td>Bounces over {e.health.max_bounce_rate * 100}%, complaints over {e.health.max_complaint_rate * 100}%, inbox placement under {e.health.min_seed_placement * 100}%</td></tr>
              <tr><td>Lead data (AI Ark)</td><td>{ark.max_credits_per_month} credits a month, at most {ark.max_credits_per_run} per run, only enough to keep {ark.stock_days} days of emails waiting · {env.AI_ARK_API_KEY ? (env.AI_ARK_TERMS_OK === "1" ? <Badge value="On" tone="good" /> : <Badge value="Key set, waiting on terms review" tone="warn" />) : <Badge value="No key" />}</td></tr>
              <tr><td>Email verifier</td><td>{verifier?.name ? pretty(verifier.name) : <Badge value="Not configured (ZEROBOUNCE_API_KEY)" tone="warn" />}</td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Models" sub="Which model handles each job. Change config/llm.yaml to reroute a task.">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Model</th>
              </tr>
            </thead>
            <tbody>
              {TASKS.map((t) => (
                <tr key={t}>
                  <td className="primary">{pretty(t)}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {cfg.llm.tasks[t].map((r, i) => (
                        <span key={i} className={`chip ${r.model && providerOk[r.provider] ? "good" : ""}`}>
                          {r.model || "(unset)"}
                          {i > 0 && " fallback"}
                        </span>
                      ))}
                      {!cfg.llm.tasks[t].some((r) => providerOk[r.provider]) && <span className="small muted">no API key</span>}
                    </div>
                  </td>
                </tr>
              ))}
              {DECISION_TASKS.filter((t) => cfg.llm.decisions[t]?.length).map((t) => (
                <tr key={`d-${t}`}>
                  <td className="primary">{pretty(t)} (classifier)</td>
                  <td>
                    {cfg.llm.decisions[t]!.map((r, i) => (
                      <span key={i} className={`chip ${providerOk[r.provider] ? "good" : ""}`} style={{ marginRight: 6 }}>
                        {r.provider}/{r.model}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Business context" sub="What the writer is allowed to say. It can only use these proof points and facts it researched.">
        <div className="table-wrap">
          <table className="kv">
            <tbody>
              <tr><td>Company</td><td><span className="strong">{cfg.business.company.name}</span> · {cfg.business.company.one_liner}</td></tr>
              <tr><td>Thesis</td><td>{cfg.business.company.thesis}</td></tr>
              <tr><td>Strengths</td><td>{cfg.business.company.strengths.map(pretty).join(", ")}</td></tr>
              <tr>
                <td>Proof points</td>
                <td>{cfg.proofPoints.length ? <ul className="plain">{cfg.proofPoints.map((pp) => <li key={pp.id}><Badge value={pp.id} tone="accent" /> {pp.text}</li>)}</ul> : <span className="muted">None yet. Emails can't make product claims until these are added.</span>}</td>
              </tr>
              <tr><td>Never say</td><td>{cfg.business.company.banned_claims.join(" · ") || <span className="muted">None listed</span>}</td></tr>
              <tr><td>Segments</td><td><div className="row" style={{ gap: 6 }}>{cfg.business.icp.segments.map((s) => <Badge key={s.id} value={s.id} />)}</div></td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Latest weekly digest">
        {digest[0] ? (
          <div className="card">
            <div className="small muted" style={{ marginBottom: 10 }}>{when(digest[0].createdAt)}</div>
            <pre className="md">{(digest[0].data as { markdown?: string }).markdown}</pre>
          </div>
        ) : (
          <Empty icon="file" title="No digest yet">
            It is written every Monday at 8:00 AM ({TEAM_TZ_LABEL}), or run <code>pnpm gtm digest</code>.
          </Empty>
        )}
      </Section>

      <Section title="Audit log" count={log.length} sub="The last 30 changes made from this dashboard or the CLI.">
        {log.length === 0 ? (
          <Empty icon="file" title="Nothing logged yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>On</th>
                </tr>
              </thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.id}>
                    <td className="small muted" style={{ width: 140, whiteSpace: "nowrap" }}>{when(l.createdAt)}</td>
                    <td className="small">{l.actor}</td>
                    <td className="small primary">{l.action}</td>
                    <td className="small muted">
                      {l.entity} <span className="mono">{l.entityId?.slice(0, 8)}</span>
                    </td>
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
