import { suppression, suppressionLeaks } from "@opengtm/core";
import { desc, ilike, or, sql } from "drizzle-orm";
import { ConfirmButton } from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { Badge, Empty, Flash, Notice, PageHeader, PageTitle, Section } from "../../components/ui";
import { when } from "../../lib/format";
import { rtReady } from "../../lib/runtime";
import { addSuppressionAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Suppress list" };

export default async function Suppress({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; q?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await rtReady();
  const q = (sp.q ?? "").trim();
  const rows = await ctx.db
    .select()
    .from(suppression)
    .where(q ? or(ilike(suppression.email, `%${q}%`), ilike(suppression.domain, `%${q}%`), ilike(suppression.reason, `%${q}%`)) : undefined)
    .orderBy(desc(suppression.createdAt))
    .limit(300);
  const [[totals], leaks] = await Promise.all([
    ctx.db.select({ emails: sql<number>`count(${suppression.email})::int`, companies: sql<number>`count(${suppression.domain})::int` }).from(suppression),
    suppressionLeaks(ctx.db),
  ]);

  return (
    <>
      <PageHeader
        icon="shield"
        title="Suppress list"
        actions={
          <form className="row" role="search">
            <label className="search">
              <Icon name="search" />
              <input name="q" defaultValue={q} placeholder="Search email, domain or reason" aria-label="Search suppressions" />
            </label>
          </form>
        }
      />
      <PageTitle title="Suppress list">People and companies that are never emailed. Opt-outs, hard bounces and hostile replies land here automatically and stay forever. Add your own customers, partners or anyone who asked by phone.</PageTitle>
      <Flash ok={sp.ok} error={sp.error} />
      {leaks.length === 0 ? (
        <Notice tone="good">
          Safety check passed: none of the {(totals?.emails ?? 0).toLocaleString()} people or {(totals?.companies ?? 0).toLocaleString()} companies on this list has been emailed since they were added. Every send is checked against the address, the email domain and the company&apos;s website, and this check reruns every 15 minutes.
        </Notice>
      ) : (
        <Notice tone="bad">
          {leaks.length} email{leaks.length === 1 ? "" : "s"} went to someone after they were suppressed:{" "}
          {leaks.slice(0, 5).map((l) => `${l.to} (${when(l.sentAt)}, listed as ${l.entry})`).join("; ")}. Sending stops automatically when this happens; check the kill switch on the Dashboard.
        </Notice>
      )}

      <Section title="Add">
        <form action={addSuppressionAction} className="card stack">
          <label className="field">
            <span>Emails or domains, one per line (or comma-separated)</span>
            <textarea name="entries" placeholder={"jane@company.com\nexistingcustomer.com"} />
            <small>A domain blocks everyone at that company. You can paste a whole column from a spreadsheet.</small>
          </label>
          <div className="row">
            <input name="reason" placeholder="Reason (e.g. existing customer)" style={{ flex: 1, minWidth: 200 }} aria-label="Reason" />
            <ConfirmButton className="primary" confirm="Suppress these permanently?">
              Add to suppress list
            </ConfirmButton>
          </div>
        </form>
      </Section>

      <Section title={q ? "Matches" : "Everyone suppressed"} count={rows.length} sub={rows.length === 300 ? "Showing the newest 300." : undefined}>
        {rows.length === 0 ? (
          <Empty icon="shield" title={q ? "No matches" : "Nobody suppressed yet"} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email or domain</th>
                  <th>Why</th>
                  <th>Added by</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="primary">
                      {r.email ?? `@${r.domain}`} {r.domain && !r.email && <Badge value="whole company" tone="warn" />}
                    </td>
                    <td>{r.reason}</td>
                    <td className="small muted">{r.source}</td>
                    <td className="small muted">{when(r.createdAt)}</td>
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
