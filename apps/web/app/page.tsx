import {
  campaigns,
  companies,
  contacts,
  isKillSwitchOn,
  lastTeamDays,
  mailboxes,
  messages,
  newReplyText,
  nextCronRun,
  replies,
  savingsByDay,
  savingsDays,
  sendingBlockers,
  startOfTeamDay,
  TEAM_TZ,
  TEAM_TZ_LABEL,
  teamDay,
  threads,
} from "@opengtm/core";
import { segmentFunnel } from "@opengtm/learning";
import { dailyCap } from "@opengtm/sequencer";
import { JOB_PLAN } from "@opengtm/worker/jobs";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import Link from "next/link";
import { BarSpark, Chart, CountUp, Sparkline } from "../components/Chart";
import { ConfirmButton } from "../components/ConfirmButton";
import { Segmented } from "../components/Segmented";
import { Icon, type IconName } from "../components/Icon";
import { initials, pretty } from "../components/ui";
import { ago, clock, name, sendDaysText, STATUS_NAME, usd } from "../lib/format";
import { rtReady } from "../lib/runtime";
import { segmentStatus, toggleKill } from "./actions";
import { APP_NAME } from "../lib/brand";

export const dynamic = "force-dynamic";

type DayRow = { d: string; a: number; b: number };
const rows = (r: unknown) => (r as { rows: Record<string, unknown>[] }).rows;
const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** One color per campaign line, in a fixed order (the busiest campaign gets the accent color). */
const CAMP_COLORS = ["c1", "c3", "c4", "c5"] as const;

/** Which way a series moved: the second half of the days against the first. */
function trend(values: number[]): "up" | "down" | "flat" {
  const h = Math.floor(values.length / 2);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const a = avg(values.slice(0, h));
  const b = avg(values.slice(values.length - h));
  return b > a ? "up" : b < a ? "down" : "flat";
}

/** Change against the period before, in plain numbers (volumes are small, so percentages would jump around). */
function Delta({ now, before, span }: { now: number; before: number; span: number }) {
  const d = now - before;
  const vs = <span className="sr"> vs the {span} days before</span>;
  if (!d)
    return (
      <span className="delta" title={`Same as the ${span} days before`}>
        Same{vs}
      </span>
    );
  return (
    <span className={`delta ${d > 0 ? "up" : "down"}`} title={`${Math.abs(d).toLocaleString("en-US")} ${d > 0 ? "more" : "fewer"} than the ${span} days before`}>
      {d > 0 ? "↑" : "↓"} {Math.abs(d).toLocaleString("en-US")}
      {vs}
    </span>
  );
}

/**
 * The pipeline drawn to scale under its numbers: one band per stage, as tall as its count (square-root
 * scale, so meetings stay visible next to thousands of leads), joined by smooth necks.
 */
function Ribbon({ values }: { values: number[] }) {
  const W = 600;
  const H = 64;
  const n = values.length;
  const col = W / n;
  const pad = col * 0.2;
  const top = Math.max(1, ...values);
  const half = values.map((v) => Math.max(v ? 3 : 1, Math.sqrt(v / top) * (H / 2 - 2)));
  const from = (i: number) => (i === 0 ? 0 : i * col + pad);
  const to = (i: number) => (i === n - 1 ? W : (i + 1) * col - pad);
  const neck = (i: number) => (i + 1) * col; // where band i hands over to band i + 1
  const up = (i: number) => H / 2 - half[i]!;
  const down = (i: number) => H / 2 + half[i]!;
  let d = `M${from(0)},${up(0)}`;
  for (let i = 0; i < n; i++) {
    d += ` L${to(i)},${up(i)}`;
    if (i < n - 1) d += ` C${neck(i)},${up(i)} ${neck(i)},${up(i + 1)} ${from(i + 1)},${up(i + 1)}`;
  }
  for (let i = n - 1; i >= 0; i--) {
    d += ` L${to(i)},${down(i)} L${from(i)},${down(i)}`;
    if (i > 0) d += ` C${neck(i - 1)},${down(i)} ${neck(i - 1)},${down(i - 1)} ${to(i - 1)},${down(i - 1)}`;
  }
  return (
    <div className="funnel-ribbon" aria-hidden>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="rib-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" className="rib-stop-a" />
            <stop offset="100%" className="rib-stop-b" />
          </linearGradient>
        </defs>
        {values.slice(1).map((_, i) => (
          <line key={i} x1={(i + 1) * col} x2={(i + 1) * col} y1={0} y2={H} className="sep" />
        ))}
        <path d={`${d} Z`} className="rib" />
      </svg>
    </div>
  );
}

/** "Today 10:42 AM", "Tomorrow 6:00 AM" or "Wed 6:00 AM", on the team's clock. */
function soon(d: Date | null | undefined, now: Date): string {
  if (!d) return "—";
  const at = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TEAM_TZ });
  const days = Math.round((Date.parse(`${teamDay(d)}T12:00:00Z`) - Date.parse(`${teamDay(now)}T12:00:00Z`)) / 86_400_000);
  return `${days <= 0 ? "Today" : days === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "short", timeZone: TEAM_TZ })} ${at}`;
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { range } = await searchParams;
  const span = range === "30" ? 30 : 7;
  const { ctx, dryRun } = await rtReady();
  const now = new Date();
  // Days on the team's calendar; the period before is used for the change arrows.
  const both = lastTeamDays(span * 2, now);
  const keys = both.slice(span);
  const since = startOfTeamDay(new Date(`${keys[0]}T12:00:00Z`));
  const prevSince = startOfTeamDay(new Date(`${both[0]}T12:00:00Z`));
  const n = sql<number>`count(*)::int`;
  const allDays = savingsDays(ctx.config.engine, now);
  const allStart = startOfTeamDay(new Date(`${allDays[0]}T12:00:00Z`));
  const allTime = Promise.all([
    ctx.db.execute(sql`select to_char(sent_at at time zone ${TEAM_TZ}, 'YYYY-MM-DD') d, count(*)::int a, 0 b from ${messages} where status = 'sent' and sent_at >= ${allStart} group by 1`),
    ctx.db.execute(sql`select to_char(created_at at time zone ${TEAM_TZ}, 'YYYY-MM-DD') d, coalesce(sum(amount_usd), 0)::float8 a, 0 b from spend_ledger where created_at >= ${allStart} group by 1`),
  ]);
  // For the comparison charts: sends per campaign per day, and the period before, day by day (read only).
  const extra = Promise.all([
    ctx.db.execute(
      sql`select to_char(m.sent_at at time zone ${TEAM_TZ}, 'YYYY-MM-DD') d, c.segment_id s, count(*)::int a from ${messages} m join ${threads} t on t.id = m.thread_id join ${campaigns} c on c.id = t.campaign_id where m.status = 'sent' and m.sent_at >= ${since} group by 1, 2`,
    ),
    ctx.db.execute(
      sql`select to_char(sent_at at time zone ${TEAM_TZ}, 'YYYY-MM-DD') d, count(*)::int a, 0 b from ${messages} where status = 'sent' and sent_at >= ${prevSince} and sent_at < ${since} group by 1`,
    ),
    ctx.db.execute(
      sql`select to_char(received_at at time zone ${TEAM_TZ}, 'YYYY-MM-DD') d, count(*)::int a, 0 b from ${replies} where received_at >= ${prevSince} and received_at < ${since} group by 1`,
    ),
  ]);
  const [killed, funnel, sentDays, replyDays, spendDays, prev, [hot], [drafts], [toCheck], last, mbs, [nextEmail]] = await Promise.all([
    isKillSwitchOn(ctx.db),
    segmentFunnel(ctx, since),
    ctx.db.execute(
      sql`select to_char(sent_at at time zone ${TEAM_TZ}, 'YYYY-MM-DD') d, count(*) filter (where step_number = 1)::int a, count(*) filter (where step_number between 2 and 99)::int b from ${messages} where status = 'sent' and sent_at >= ${since} group by 1`,
    ),
    ctx.db.execute(
      sql`select to_char(received_at at time zone ${TEAM_TZ}, 'YYYY-MM-DD') d, count(*)::int a, count(*) filter (where hot)::int b from ${replies} where received_at >= ${since} group by 1`,
    ),
    ctx.db.execute(sql`select to_char(created_at at time zone ${TEAM_TZ}, 'YYYY-MM-DD') d, coalesce(sum(amount_usd), 0)::float8 a, 0 b from spend_ledger where created_at >= ${since} group by 1`),
    ctx.db.execute(sql`select
        (select count(*)::int from ${messages} where status = 'sent' and sent_at >= ${prevSince} and sent_at < ${since}) sent,
        (select count(*)::int from ${replies} where received_at >= ${prevSince} and received_at < ${since}) replies,
        (select count(*) filter (where hot)::int from ${replies} where received_at >= ${prevSince} and received_at < ${since}) hot`),
    ctx.db
      .select({ n })
      .from(replies)
      .where(and(eq(replies.hot, true), or(eq(replies.handled, false), eq(replies.draftState, "pending")))),
    ctx.db
      .select({ n })
      .from(messages)
      .where(and(eq(messages.status, "draft"), inArray(messages.approvalState, ["pending", "needs_review"]))),
    ctx.db
      .select({ n })
      .from(replies)
      .where(and(eq(replies.hot, false), or(eq(replies.handled, false), eq(replies.draftState, "pending")))),
    ctx.db
      .select({ r: replies, c: contacts, co: companies, seg: campaigns.segmentId })
      .from(replies)
      .leftJoin(contacts, eq(contacts.id, replies.contactId))
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .leftJoin(threads, eq(threads.id, replies.threadId))
      .leftJoin(campaigns, eq(campaigns.id, threads.campaignId))
      .orderBy(desc(replies.receivedAt))
      .limit(6),
    ctx.db.select().from(mailboxes),
    ctx.db.select({ at: messages.scheduledFor }).from(messages).where(eq(messages.status, "scheduled")).orderBy(asc(messages.scheduledFor)).limit(1),
  ]);

  const days = keys.map((k) => new Date(`${k}T12:00:00Z`));
  const labels = days.map((d) =>
    span === 7 ? d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
  );
  const fullLabels = days.map((d) => d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }));
  const series = (r: unknown) => {
    const m = new Map((rows(r) as DayRow[]).map((x) => [x.d, x]));
    return { a: keys.map((k) => Number(m.get(k)?.a ?? 0)), b: keys.map((k) => Number(m.get(k)?.b ?? 0)) };
  };
  const sent = series(sentDays);
  const rep = series(replyDays);
  const sp = series(spendDays);
  const before = rows(prev)[0] as { sent: number; replies: number; hot: number };
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  const sentPerDay = sent.a.map((v, i) => v + (sent.b[i] ?? 0));
  const caps = ctx.config.engine.caps;
  const sentToday = mbs.reduce((s, m) => s + (m.sentTodayDate === teamDay(now) ? m.sentToday : 0), 0);
  const capToday = Math.min(
    caps.daily_send_cap,
    mbs.filter((m) => m.status === "active").reduce((s, m) => s + dailyCap(m, now, ctx.config.engine.ramp), 0),
  );
  const t = ctx.config.engine.timing;
  const blockers = sendingBlockers(ctx.config);
  const tot = funnel.reduce(
    (a, f) => ({
      sourced: a.sourced + f.sourced,
      verified: a.verified + f.verified,
      sent: a.sent + f.emailed,
      replied: a.replied + f.replied,
      hot: a.hot + f.hot,
      booked: a.booked + f.booked,
      cost: a.cost + f.costUsd,
    }),
    { sourced: 0, verified: 0, sent: 0, replied: 0, hot: 0, booked: 0, cost: 0 },
  );
  const running = funnel.filter((f) => f.status !== "paused").length;
  const saving = savingsByDay(ctx.config.engine, sentPerDay, sp.a, keys);
  const [allSent, allSpend] = await allTime;
  const [campDays, prevSentDays, prevReplyDays] = await extra;
  const prevKeys = both.slice(0, span);
  const prevSeries = (r: unknown) => {
    const m = new Map((rows(r) as DayRow[]).map((x) => [x.d, Number(x.a)]));
    return prevKeys.map((k) => m.get(k) ?? 0);
  };
  const prevSent = prevSeries(prevSentDays);
  const prevRep = prevSeries(prevReplyDays);
  const byCamp = new Map<string, number[]>();
  for (const r of rows(campDays) as { d: string; s: string; a: number }[]) {
    const line = byCamp.get(r.s) ?? keys.map(() => 0);
    const i = keys.indexOf(r.d);
    if (i >= 0) line[i] = (line[i] ?? 0) + Number(r.a);
    byCamp.set(r.s, line);
  }
  const topCamps = [...byCamp.entries()].sort((x, y) => sum(y[1]) - sum(x[1])).slice(0, 4);
  const savedPerDay = saving.theirs.map((v, i) => v - (saving.ours[i] ?? 0));
  const breakdown: { k: string; v: string; values: number[]; good: "up" | "down" }[] = [
    { k: "First emails", v: sum(sent.a).toLocaleString("en-US"), values: sent.a, good: "up" },
    { k: "Follow-ups", v: sum(sent.b).toLocaleString("en-US"), values: sent.b, good: "up" },
    { k: "Replies", v: sum(rep.a).toLocaleString("en-US"), values: rep.a, good: "up" },
    { k: "Hot leads", v: sum(rep.b).toLocaleString("en-US"), values: rep.b, good: "up" },
    { k: "AI and data spend", v: usd(sum(sp.a)), values: sp.a, good: "down" },
    ...(ctx.config.engine.savings.replaces.length ? [{ k: `Saved vs ${ctx.config.engine.savings.replaces[0]!.name}`, v: usd(saving.total.saved), values: savedPerDay, good: "up" as const }] : []),
  ];
  // Same count as the campaign lines: emails sent in the period, per campaign.
  const topList = [...byCamp.entries()]
    .map(([segmentId, v]) => ({ segmentId, emailed: sum(v) }))
    .sort((x, y) => y.emailed - x.emailed)
    .slice(0, 5);
  const topMax = Math.max(1, ...topList.map((f) => f.emailed));
  const onDays = (r: unknown) => {
    const m = new Map((rows(r) as DayRow[]).map((x) => [x.d, Number(x.a)]));
    return allDays.map((d) => m.get(d) ?? 0);
  };
  const lifetime = savingsByDay(ctx.config.engine, onDays(allSent), onDays(allSpend), allDays);
  const savedSince = new Date(`${allDays[0]}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const savedNote = lifetime.total.emails
    ? `${lifetime.vendors.map((v) => `${v.name} (${v.plan}) would have charged ${usd(v.total)}`).join(", ")} for ${lifetime.total.emails.toLocaleString("en-US")} emails. We paid ${usd(lifetime.total.ours)} for AI, data and mailboxes.`
    : `Nothing sent yet, so only the mailboxes (${usd(lifetime.total.ours)} so far) count against it.`;

  const hour = Number(now.toLocaleString("en-US", { hour: "numeric", hourCycle: "h23", timeZone: TEAM_TZ }));
  const greeting = `Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}`;
  const today = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: TEAM_TZ });

  const state = killed
    ? { tone: "off", title: "Sending stopped", line: "The kill switch is on. Nothing goes out until you resume." }
    : blockers.length
      ? { tone: "warn", title: "Not sending yet", line: `Add the ${blockers.map((b) => b.field.replace("company.", "").replaceAll("_", " ")).join(" and ")} on Project docs to start.` }
      : dryRun
        ? { tone: "idle", title: "Dry run", line: "Running end to end with fake mailboxes. Nothing real is sent." }
        : { tone: "on", title: "Sending on schedule", line: `${clock(t.business_start)}–${clock(t.business_end)} their time` };

  const todo: { tone: string; icon: IconName; title: string; text: string; href: string; cta: string }[] = [];
  if (killed || blockers.length) todo.push({ tone: "warn", icon: "alert", title: state.title, text: state.line, href: killed ? "/schedule" : "/project", cta: killed ? "Details" : "Fix" });
  if (hot?.n)
    todo.push({
      tone: "hot",
      icon: "flame",
      title: `${plural(hot.n, "hot lead")} waiting`,
      text: "A reply with your booking link is drafted. Answer within the hour.",
      href: "/inbox?status=hot",
      cta: "Reply",
    });
  if (drafts?.n)
    todo.push({ tone: "brand", icon: "approvals", title: `${plural(drafts.n, "draft")} to approve`, text: "The checks flagged these, so they wait for your OK.", href: "/approvals", cta: "Review" });
  if (toCheck?.n)
    todo.push({
      tone: "",
      icon: "reply",
      title: `${plural(toCheck.n, "reply", "replies")} to look at`,
      text: "Answers are drafted and send by themselves after the review window.",
      href: "/inbox?status=all",
      cta: "Open",
    });

  const kpis = [
    {
      k: "Emails sent",
      v: sum(sentPerDay),
      spark: sentPerDay,
      color: "c1" as const,
      sub: `${sum(sent.a)} first · ${sum(sent.b)} follow-ups`,
      delta: { now: sum(sentPerDay), before: before.sent },
      href: "/inbox?status=sent",
    },
    {
      k: "Replies",
      v: sum(rep.a),
      spark: rep.a,
      color: "c1" as const,
      sub: sum(sent.a) ? `${pct(sum(rep.a), sum(sent.a)).toFixed(1)}% reply rate` : "Reply rate shows once emails go out",
      delta: { now: sum(rep.a), before: before.replies },
      href: "/inbox?status=all",
    },
    { k: "Hot leads", v: sum(rep.b), spark: rep.b, color: "hot" as const, sub: "Said yes or asked a buying question", delta: { now: sum(rep.b), before: before.hot }, href: "/inbox?status=hot" },
    {
      k: "Meetings",
      v: tot.booked,
      spark: null,
      color: "c1" as const,
      sub: tot.hot ? `${pct(tot.booked, tot.hot).toFixed(0)}% of hot leads booked` : "Booked from hot leads",
      delta: null,
      href: "/inbox?status=hot",
    },
  ];

  const stages = [
    { k: "Leads found", v: tot.sourced, href: "/leads" },
    { k: "Verified", v: tot.verified, href: "/leads" },
    { k: "Emailed", v: tot.sent, href: "/inbox?status=sent" },
    { k: "Replied", v: tot.replied, href: "/inbox?status=all" },
    { k: "Hot leads", v: tot.hot, href: "/inbox?status=hot" },
    { k: "Meetings", v: tot.booked, href: "/inbox?status=hot" },
  ];
  const top = Math.max(1, ...stages.map((s) => s.v));

  return (
    <>
      <div className="page-head">
        <div className="crumb">
          <Icon name="gauge" />
          <span>Dashboard</span>
        </div>
        <div className="actions">
          <form action={toggleKill}>
            <input type="hidden" name="on" value={killed ? "false" : "true"} />
            <input type="hidden" name="from" value="/" />
            {killed ? (
              <ConfirmButton className="primary sm" confirm="Resume sending?">
                <Icon name="power" size={14} /> Resume campaigns
              </ConfirmButton>
            ) : (
              <ConfirmButton className="danger-soft sm" confirm="Stop all campaigns and sending now?">
                <Icon name="power" size={14} /> Stop campaigns and spending
              </ConfirmButton>
            )}
          </form>
        </div>
      </div>

      <div className="dash-hero rise">
        <div className="dash-hello">
          <h1>{greeting}</h1>
          <p>
            {today} · {running} of {plural(funnel.length, "campaign")} running
          </p>
        </div>
        <div className="dash-controls">
          <Link href="/schedule" className={`live-pill tone-${state.tone}`} title={state.tone === "on" ? `${state.line}, ${sendDaysText(t)}. Open the schedule.` : state.line}>
            <span className={`dot${state.tone === "on" ? " live" : ` ${state.tone}`}`} />
            <b>{state.title}</b>
            {state.tone === "on" && <span className="pill-sub">{state.line}</span>}
          </Link>
          <Segmented className="seg-toggle" role="tablist" aria-label="Time range">
            <Link href="/?range=7" className={span === 7 ? "on" : ""} role="tab" aria-selected={span === 7}>
              7 days
            </Link>
            <Link href="/?range=30" className={span === 30 ? "on" : ""} role="tab" aria-selected={span === 30}>
              30 days
            </Link>
          </Segmented>
        </div>
      </div>

      <div className="kpi-grid rise" style={{ animationDelay: "40ms" }}>
        {kpis.map((m) => (
          <Link key={m.k} href={m.href} className="kpi">
            <span className="kpi-k">{m.k}</span>
            <span className="kpi-row">
              <span className="kpi-v">
                <CountUp value={m.v} />
              </span>
              {m.delta && <Delta now={m.delta.now} before={m.delta.before} span={span} />}
              {m.spark && <BarSpark values={m.spark} label={`${m.k} per day`} />}
            </span>
            <span className="kpi-s">{m.sub}</span>
          </Link>
        ))}
        {ctx.config.engine.savings.replaces.length > 0 && (
          <div className="kpi" title={`${savedNote} Safety caps: ${usd(caps.daily_spend_cap_usd, 0)} a day of AI and data, ${caps.daily_send_cap} emails a day.`}>
            <span className="kpi-k">Saved since {savedSince}</span>
            <span className="kpi-row">
              <span className={`kpi-v${lifetime.total.saved < 0 ? " neg" : " good"}`}>
                <CountUp value={lifetime.total.saved} format="usd" />
              </span>
              <BarSpark values={savedPerDay} label="Saved per day" />
            </span>
            <span className="kpi-s">
              vs paying {lifetime.compareTo} · {usd(saving.total.saved)} in the last {span} days
            </span>
          </div>
        )}
      </div>

      <div className="dash-main">
        <div className="card flush activity rise" style={{ animationDelay: "80ms" }}>
          <div className="card-title pad">
            <Icon name="bars" size={15} />
            <h2>Emails sent</h2>
            <p>Per day, {TEAM_TZ_LABEL}</p>
            <div className="legend">
              <span>
                <i className="key bg-c1" /> First emails
              </span>
              <span>
                <i className="key bg-c2" /> Follow-ups
              </span>
            </div>
          </div>
          <Chart
            kind="columns"
            height={232}
            labels={labels}
            fullLabels={fullLabels}
            series={[
              { name: "first emails", values: sent.a, color: "c1" },
              { name: "follow-ups", values: sent.b, color: "c2" },
            ]}
          />
          <div className="card-foot activity-foot">
            <span>
              Showing the last {span} days · {sum(sent.a).toLocaleString("en-US")} first emails, {sum(sent.b).toLocaleString("en-US")} follow-ups
            </span>
            <Link href="/schedule">
              Schedule <Icon name="arrow" size={13} />
            </Link>
          </div>
        </div>

        <div className="card flush needs rise" style={{ animationDelay: "120ms" }}>
          <div className="card-title pad">
            <Icon name="bell" size={15} />
            <h2>Needs you</h2>
            {todo.length > 0 && <span className="count">{todo.length}</span>}
          </div>
          {todo.length === 0 ? (
            <div className="caught-up">
              <span className="ico">
                <Icon name="check" size={18} />
              </span>
              <div>
                <b>You're all caught up</b>
                <p>Hot leads land here with a reply ready. {APP_NAME} keeps finding, writing and sending on its own.</p>
              </div>
            </div>
          ) : (
            <ul className="needs-list">
              {todo.map((x) => (
                <li key={x.title}>
                  <Link href={x.href} className={`need tone-${x.tone || "plain"}`}>
                    <span className="ico">
                      <Icon name={x.icon} size={16} />
                    </span>
                    <span className="what">
                      <b>{x.title}</b>
                      <span>{x.text}</span>
                    </span>
                    <span className="cta">
                      {x.cta} <Icon name="arrow" size={13} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <dl className="today">
            <div>
              <dt>Sent today</dt>
              <dd>
                {sentToday} <span className="muted">of {capToday}</span>
              </dd>
            </div>
            <div>
              <dt>Next email</dt>
              <dd>{killed ? "Paused" : soon(nextEmail?.at, now)}</dd>
            </div>
            <div>
              <dt>Next lead search</dt>
              <dd>{soon(nextCronRun(JOB_PLAN.discover.cron, now), now)}</dd>
            </div>
          </dl>
          <div className="needs-foot">
            <Link href="/schedule">
              <Icon name="calendar" size={14} /> Schedule
            </Link>
            <Link href="/sequence">
              <Icon name="mail" size={14} /> Email sequence
            </Link>
            <Link href="/leads">
              <Icon name="users" size={14} /> Leads
            </Link>
          </div>
        </div>
      </div>

      <div className="dash-row two">
        <div className="card chart-card rise">
          <div className="cc-k">Emails by campaign</div>
          <div className="cc-v">
            <span className="cc-n">
              <CountUp value={sum(sentPerDay)} />
            </span>
            <Delta now={sum(sentPerDay)} before={sum(prevSent)} span={span} />
          </div>
          <Chart kind="lines" height={230} labels={labels} fullLabels={fullLabels} series={topCamps.map(([id, values], i) => ({ name: pretty(id), values, color: CAMP_COLORS[i]! }))} />
          <div className="cc-foot legend">
            {topCamps.map(([id], i) => (
              <span key={id}>
                <i className={`key bg-${CAMP_COLORS[i]}`} /> {pretty(id)}
              </span>
            ))}
            <span className="muted push">{topCamps.length ? `Top ${topCamps.length} campaigns by emails sent` : "No emails sent in this period"}</span>
          </div>
        </div>

        <div className="card chart-card rise">
          <div className="cc-k">Breakdown</div>
          <ul className="brk">
            {breakdown.map((b) => {
              const t = trend(b.values);
              return (
                <li key={b.k}>
                  <span>{b.k}</span>
                  <b>{b.v}</b>
                  <Sparkline values={b.values} color={t === "flat" ? "flat" : t === b.good ? "good" : "bad"} label={`${b.k} per day`} />
                </li>
              );
            })}
          </ul>
          <div className="cc-foot">Last {span} days, every campaign</div>
        </div>
      </div>

      <div className="dash-row three">
        <div className="card chart-card rise">
          <div className="cc-k">Top campaigns</div>
          {topList.length ? (
            <ul className="toplist">
              {topList.map((f) => (
                <li key={f.segmentId}>
                  <Link href={`/campaigns#${f.segmentId}`}>
                    <span>{pretty(f.segmentId)}</span>
                    <b>{f.emailed.toLocaleString("en-US")}</b>
                  </Link>
                  <span className="bar">
                    <span style={{ width: `${Math.max(f.emailed ? 3 : 0, (f.emailed / topMax) * 100)}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Campaigns rank here once emails go out.</p>
          )}
          <div className="cc-foot">Emails sent, last {span} days</div>
        </div>

        <div className="card chart-card rise">
          <div className="cc-k">Emails sent</div>
          <div className="cc-v">
            <span className="cc-n">
              <CountUp value={sum(sentPerDay)} />
            </span>
            <Delta now={sum(sentPerDay)} before={sum(prevSent)} span={span} />
          </div>
          <Chart
            kind="lines"
            height={150}
            labels={labels}
            fullLabels={fullLabels}
            series={[
              { name: "this period", values: sentPerDay, color: "c1" },
              { name: span === 7 ? "a week earlier" : "30 days earlier", values: prevSent, color: "prev" },
            ]}
          />
          <div className="cc-foot">
            These {span} days vs. the {span} before
          </div>
        </div>

        <div className="card chart-card rise">
          <div className="cc-k">Replies</div>
          <div className="cc-v">
            <span className="cc-n">
              <CountUp value={sum(rep.a)} />
            </span>
            <Delta now={sum(rep.a)} before={sum(prevRep)} span={span} />
          </div>
          <Chart
            kind="lines"
            height={150}
            labels={labels}
            fullLabels={fullLabels}
            series={[
              { name: "this period", values: rep.a, color: "c1" },
              { name: span === 7 ? "a week earlier" : "30 days earlier", values: prevRep, color: "prev" },
            ]}
          />
          <div className="cc-foot">
            These {span} days vs. the {span} before
          </div>
        </div>
      </div>

      <div className="card flush rise dash-block" style={{ animationDelay: "160ms" }}>
        <div className="card-title pad">
          <Icon name="layers" size={15} />
          <h2>Pipeline</h2>
          <span className="small muted">Last {span} days, every campaign</span>
        </div>
        <div className="funnel">
          {stages.map((s, i) => (
            <Link key={s.k} href={s.href} className="stage">
              <div className="l">{s.k}</div>
              <div className="n">
                <CountUp value={s.v} />
              </div>
              <div className="track">
                <span style={{ width: `${Math.max(s.v ? 4 : 0, pct(s.v, top))}%`, animationDelay: `${150 + i * 70}ms` }} />
              </div>
              <div className="s">
                {i === 0
                  ? "Found by lead search"
                  : stages[i - 1]!.v
                    ? `${pct(s.v, stages[i - 1]!.v).toFixed(s.v && pct(s.v, stages[i - 1]!.v) < 10 ? 1 : 0)}% of ${stages[i - 1]!.k.toLowerCase()}`
                    : "—"}
              </div>
            </Link>
          ))}
        </div>
        <Ribbon values={stages.map((s) => s.v)} />
      </div>

      <div className="card flush rise dash-block">
        <div className="card-title pad">
          <Icon name="campaigns" size={15} />
          <h2>Campaigns</h2>
          <span className="count">{funnel.length}</span>
          <Link href="/campaigns#new" className="btn sm push">
            <Icon name="plus" size={14} /> New campaign
          </Link>
        </div>
        <div className="table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th className="num">Sent</th>
                <th>Reply rate</th>
                <th className="num">Hot leads</th>
                <th className="num hide-sm">Cost / hot lead</th>
                <th className="num hide-sm">Spent</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {funnel.map((f) => {
                const rr = pct(f.replied, f.emailed);
                const paused = f.status === "paused";
                return (
                  <tr key={f.segmentId} className={paused ? "is-paused" : ""}>
                    <td>
                      <Link href={`/campaigns#${f.segmentId}`} className="camp">
                        <span className={`nav-dot ${paused ? "off" : "on"}`} />
                        <span>
                          <span className="primary">{pretty(f.segmentId)}</span>
                          <span className="camp-sub">{paused ? "Paused" : `About ${Math.round(f.sends / span)} emails a day`}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="num">{f.emailed.toLocaleString()}</td>
                    <td>
                      <div className="rate">
                        <span className="num">{rr.toFixed(1)}%</span>
                        <span className="rate-track">
                          <span style={{ width: `${Math.min(100, rr * 10)}%` }} />
                        </span>
                      </div>
                    </td>
                    <td className="num">{f.hot ? <span className="hot-n">{f.hot}</span> : <span className="muted">0</span>}</td>
                    <td className="num hide-sm">{f.hot ? usd(f.costUsd / f.hot) : <span className="muted">—</span>}</td>
                    <td className="num hide-sm">{usd(f.costUsd)}</td>
                    <td className="row-action">
                      <form action={segmentStatus}>
                        <input type="hidden" name="id" value={f.segmentId} />
                        <input type="hidden" name="status" value={paused ? "active" : "paused"} />
                        <ConfirmButton className="sm ghost" confirm={paused ? "Resume this campaign?" : "Pause this campaign?"}>
                          {paused ? "Resume" : "Pause"}
                        </ConfirmButton>
                      </form>
                    </td>
                  </tr>
                );
              })}
              <tr className="total">
                <td>
                  Total <span className="camp-sub inline">{running} running</span>
                </td>
                <td className="num">{tot.sent.toLocaleString()}</td>
                <td className="num" style={{ textAlign: "left" }}>
                  {pct(tot.replied, tot.sent).toFixed(1)}%
                </td>
                <td className="num">{tot.hot}</td>
                <td className="num hide-sm">{tot.hot ? usd(tot.cost / tot.hot) : "—"}</td>
                <td className="num hide-sm">{usd(tot.cost)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card flush rise dash-block">
        <div className="card-title pad">
          <Icon name="reply" size={15} />
          <h2>Latest replies</h2>
          <p>Newest first</p>
          <Link href="/inbox?status=all" className="btn sm push">
            Open inbox <Icon name="arrow" size={14} />
          </Link>
        </div>
        {last.length === 0 ? (
          <div className="caught-up quiet">
            <span className="ico">
              <Icon name="inbox" size={18} />
            </span>
            <div>
              <b>No replies yet</b>
              <p>They show up here and in the Inbox as they arrive, already read and sorted.</p>
            </div>
          </div>
        ) : (
          <div className="reply-list">
            {last.map(({ r, c, co, seg }) => {
              const needs = !r.handled || r.draftState === "pending";
              return (
                <Link key={r.id} href={`/inbox?status=all&c=${r.id}`} className="reply-row">
                  <span className={`avatar${r.hot ? " hot" : ""}`}>{initials(c ? name(c) : r.fromEmail)}</span>
                  <span className="who">
                    <span className="name">{c ? name(c) : r.fromEmail}</span>
                    <span className="meta">{co?.name}</span>
                  </span>
                  <span className="snippet">{newReplyText(r.body).replace(/\s+/g, " ") || r.body.slice(0, 120)}</span>
                  <span className="small muted camp-name">{seg ? pretty(seg) : ""}</span>
                  <span className="tags">
                    {r.hot && (
                      <span className="chip hot">
                        <Icon name="flame" size={12} /> Hot
                      </span>
                    )}
                    {needs ? <span className="chip needs">Needs reply</span> : !r.hot && <span className="chip">{STATUS_NAME[r.label ?? ""] ?? "New"}</span>}
                  </span>
                  <span className="small muted when">{ago(r.receivedAt, now)}</span>
                  <Icon name="chevron" size={14} className="go" />
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
