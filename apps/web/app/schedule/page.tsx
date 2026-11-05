import { billingCycleStart, TEAM_TZ, TEAM_TZ_LABEL, companies, contacts, mailboxes, messages, nextCronRun, refSpendSince, teamDay } from "@opengtm/core";
import { dailyCap } from "@opengtm/sequencer";
import { JOB_PLAN } from "@opengtm/worker/jobs";
import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { Empty, Flash, Metric, PageHeader, PageTitle, Section } from "../../components/ui";
import { runDiscoverNowAction } from "../actions";
import { clock, name, sendDaysText, whenPT } from "../../lib/format";
import { rtReady } from "../../lib/runtime";
import { APP_NAME } from "../../lib/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedule" };

const DOW = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** Hours a time zone is ahead of UTC at a moment (e.g. -7 for Pacific in summer). */
function utcOffsetHours(tz: string, at: Date): number {
  const wall = (zone: string) => new Date(at.toLocaleString("en-US", { timeZone: zone })).getTime();
  return Math.round((wall(tz) - wall("UTC")) / 1_800_000) / 2;
}

/** A cron in plain words, on the team's clock. */
function cronWords(cron: string): string {
  const [m, h, , , dow] = cron.split(" ");
  if (h === "*") return m === "*" ? "Every minute" : `Every ${m!.replace("*/", "")} minutes`;
  const at = clock(`${h}:${m!.padStart(2, "0")}`);
  if (dow === "*") return `Daily at ${at}`;
  if (dow === "1-5") return `Weekdays at ${at}`;
  return `${dow!.split(",").map((d) => DOW[Number(d) % 7]).join(" and ")} at ${at}`;
}

export default async function Schedule({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await rtReady();
  const e = ctx.config.engine;
  const t = e.timing;
  const now = new Date();
  const cycleStart = billingCycleStart(now, e.leads.ai_ark.renews_on_day);
  const [mbs, upcoming, arkSpend] = await Promise.all([
    ctx.db.select().from(mailboxes).orderBy(asc(mailboxes.email)),
    ctx.db
      .select({ m: messages, c: contacts, co: companies, mb: mailboxes })
      .from(messages)
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .leftJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
      .where(eq(messages.status, "scheduled"))
      .orderBy(asc(messages.scheduledFor))
      .limit(15),
    refSpendSince(ctx.db, "ai_ark", cycleStart),
  ]);

  const active = mbs.filter((m) => m.status === "active");
  const capToday = Math.min(e.caps.daily_send_cap, active.reduce((s, m) => s + dailyCap(m, now, e.ramp), 0));
  const sentToday = mbs.reduce((s, m) => s + (m.sentTodayDate === teamDay(now) ? m.sentToday : 0), 0);
  const ark = e.leads.ai_ark;
  const creditsUsed = ark.credit_usd > 0 ? Math.round(arkSpend / ark.credit_usd) : 0;
  const creditsLeft = Math.max(0, ark.max_credits_per_month - creditsUsed);
  const nextSearch = nextCronRun(JOB_PLAN.discover.cron, now);
  const followUps = e.sequence.steps.filter((s) => s.step > 1);
  const tiers = [...e.ramp.tiers].sort((a, b) => a.from_week - b.from_week);
  const autoReply = e.replies.auto_reply;
  // Business hours are the recipient's own; seen from the team's clock, e.g. from Pacific, Eastern recipients start 3 hours earlier.
  const zones = [
    { k: "Eastern", tz: "America/New_York" },
    { k: "Central", tz: "America/Chicago" },
    { k: "Mountain", tz: "America/Denver" },
    { k: "Pacific", tz: "America/Los_Angeles" },
  ].map((z) => ({ k: z.k, shift: utcOffsetHours(TEAM_TZ, now) - utcOffsetHours(z.tz, now) }));

  return (
    <>
      <PageHeader
        icon="calendar"
        title="Schedule"
        actions={
          <form action={runDiscoverNowAction}>
            <button type="submit">Search for leads now</button>
          </form>
        }
      />
      <PageTitle title="Schedule">When {APP_NAME} works and when emails go out. Every time on this page is in the team time zone ({TEAM_TZ}).</PageTitle>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid fit">
        <Metric icon="send" label="Next email" value={upcoming[0]?.m.scheduledFor ? whenPT(upcoming[0].m.scheduledFor) : "None queued"} sub={upcoming.length ? `${upcoming.length}${upcoming.length === 15 ? "+" : ""} queued` : "Emails queue up after leads are found and written"} />
        <Metric icon="search" label="Next lead search" value={nextSearch ? whenPT(nextSearch) : "-"} sub={cronWords(JOB_PLAN.discover.cron)} />
        <Metric icon="mailboxes" label="Sent today" value={sentToday} meter={{ value: sentToday, max: capToday }} sub={`of ${capToday} allowed today`} />
        <Metric icon="users" label="Lead credits this cycle" value={`${creditsUsed} / ${ark.max_credits_per_month}`} meter={{ value: creditsUsed, max: ark.max_credits_per_month }} sub={`Plan renews ${new Date(Date.UTC(cycleStart.getUTCFullYear(), cycleStart.getUTCMonth() + 1, cycleStart.getUTCDate())).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · about ${Math.floor(creditsLeft / 1.45)} more people`} />
      </div>

      <div className="split" style={{ alignItems: "start", marginTop: 24 }}>
        <div>
          <Section title="When emails go out" sub="Emails land during the recipient's working day, never at night or on a day off.">
            <div className="table-wrap">
              <table>
                <tbody>
                  <tr>
                    <td className="muted">Days</td>
                    <td>{sendDaysText(t)} (the recipient's day)</td>
                  </tr>
                  <tr>
                    <td className="muted">Hours</td>
                    <td>
                      {clock(t.business_start)} to {clock(t.business_end)} in the recipient's own time zone
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">In team time ({TEAM_TZ_LABEL})</td>
                    <td>
                      {zones.map((z) => (
                        <div key={z.k}>
                          {z.k} companies: {clock(t.business_start, z.shift)} to {clock(t.business_end, z.shift)}
                        </div>
                      ))}
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Spacing</td>
                    <td>
                      {t.jitter_min_s} seconds to {Math.round(t.jitter_max_s / 60)} minutes apart from each mailbox, at random
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Follow-up</td>
                    <td>{followUps.length ? followUps.map((s) => `Email ${s.step} on day ${s.day} if they haven't replied`).join("; ") : "None, one email per person"}</td>
                  </tr>
                  <tr>
                    <td className="muted">Replies</td>
                    <td>
                      {autoReply.enabled ? `Drafted answers send themselves ${autoReply.delay_minutes >= 60 ? `${autoReply.delay_minutes / 60} hours` : `${autoReply.delay_minutes} minutes`} after the reply arrives, unless someone edits, sends or holds them. ` : "Every drafted answer waits for a person. "}
                      Hot leads always wait for you.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Coming up" count={upcoming.length} sub="The next emails queued to send, in order.">
            {upcoming.length === 0 ? (
              <Empty icon="calendar" title="Nothing queued yet">
                After the next lead search, companies are researched and emails written within the hour. Any the checker flags wait on <Link href="/approvals">Approvals</Link>.
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>To</th>
                      <th>Email</th>
                      <th>From</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcoming.map(({ m, c, co, mb }) => (
                      <tr key={m.id}>
                        <td className="nowrap">{whenPT(m.scheduledFor)}</td>
                        <td>
                          <div className="primary">{name(c)}</div>
                          <div className="small muted">{co?.name ?? c.email}</div>
                        </td>
                        <td>
                          <div>{m.subject}</div>
                          <div className="small muted">{m.stepNumber === 1 ? "First email" : `Follow-up ${m.stepNumber - 1}`}</div>
                        </td>
                        <td className="small muted">{mb?.senderName ?? "Next free mailbox"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>

        <div>
          <Section title="Daily limits" sub="A new sending domain that jumps to high volume lands in spam, so each mailbox steps up week by week.">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Mailbox age</th>
                    <th className="num">Per mailbox</th>
                    <th className="num">All {active.length}</th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((tier, i) => {
                    const next = tiers[i + 1];
                    const per = Math.min(tier.per_day, e.ramp.hard_max_per_day);
                    return (
                      <tr key={tier.from_week}>
                        <td>{next ? (next.from_week - tier.from_week === 1 ? `Week ${tier.from_week}` : `Weeks ${tier.from_week}-${next.from_week - 1}`) : `Week ${tier.from_week} on`}</td>
                        <td className="num">{per}/day</td>
                        <td className="num">{Math.min(per * active.length, e.caps.daily_send_cap)}/day</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>
              Never more than {e.caps.daily_send_cap} a day in total; today allows {capToday}. Add mailboxes on <Link href="/mailboxes">Channels</Link> to send more. For now the number of new leads decides how many go out, not this cap: {ark.max_credits_per_month.toLocaleString()} lead credits a month is
              about {Math.floor(ark.max_credits_per_month / 1.45).toLocaleString()} people (searching costs credits too, and not every company has a findable email).
            </p>
          </Section>

          <Section title="Automatic jobs" sub={`What runs by itself, and when (${TEAM_TZ_LABEL}).`}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(JOB_PLAN).map(([k, j]) => {
                    const next = nextCronRun(j.cron, now);
                    return (
                      <tr key={k}>
                        <td>
                          <div className="primary">{j.label}</div>
                          <div className="small muted">{j.detail}</div>
                        </td>
                        <td className="small">
                          <div>{k === "send" ? "Every minute, inside sending hours" : cronWords(j.cron)}</div>
                          {next && <div className="muted">Next: {whenPT(next)}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
