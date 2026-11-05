import { companies, contacts, suppression } from "@opengtm/core";
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { Icon } from "../../components/Icon";
import { Badge, Empty, PageHeader, PageTitle, pretty } from "../../components/ui";
import { when } from "../../lib/format";
import { rtReady } from "../../lib/runtime";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leads" };

const STATUSES = ["new", "qualified", "disqualified", "researched", "research_failed"];

export default async function Leads({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const sp = await searchParams;
  const { ctx } = (await rtReady());
  const q = (sp.q ?? "").trim();
  const filters: SQL[] = [];
  if (q) {
    const like = `%${q}%`;
    filters.push(
      or(
        ilike(companies.name, like),
        ilike(companies.domain, like),
        sql`exists (select 1 from contacts c where c.company_id = ${companies.id} and c.email ilike ${like})`,
      )!,
    );
  }
  if (sp.status && STATUSES.includes(sp.status)) filters.push(eq(companies.status, sp.status as (typeof companies.$inferSelect)["status"]));
  const rows = await ctx.db
    .select()
    .from(companies)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(companies.createdAt))
    .limit(200);
  const ids = rows.map((r) => r.id);
  const people = ids.length ? await ctx.db.select().from(contacts).where(inArray(contacts.companyId, ids)) : [];
  const sup = ids.length ? await ctx.db.select().from(suppression).where(inArray(suppression.domain, rows.map((r) => r.domain))) : [];
  const supDomains = new Set(sup.map((s) => s.domain));
  const filtered = Boolean(q || sp.status);

  return (
    <>
      <PageHeader icon="leads" title="Leads" />
      <PageTitle title="Leads">Every company the lead search found, with its people, status and where it came from.</PageTitle>

      <form className="filter-bar" role="search">
        <label className="search">
          <Icon name="search" />
          <input name="q" defaultValue={q} placeholder="Search company, domain or email" aria-label="Search leads" />
        </label>
        <select name="status" defaultValue={sp.status ?? ""} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {pretty(s)}
            </option>
          ))}
        </select>
        <button type="submit">Search</button>
        {filtered && (
          <Link href="/leads" className="btn">
            Clear
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        <Empty icon="search" title={filtered ? "No leads match" : "No leads yet"}>
          {filtered ? "Try a different name, domain or status." : "Companies appear here after the morning discover run (weekdays at 6:00 AM, team time). See Schedule for the next run."}
        </Empty>
      ) : (
        <>
          <div className="section-head">
            <h2>{filtered ? "Results" : "All companies"}</h2>
            <span className="count">{rows.length}</span>
            {rows.length === 200 && <span className="small muted">Showing the newest 200</span>}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Segment</th>
                  <th>Status</th>
                  <th className="num">ICP</th>
                  <th>Contacts</th>
                  <th>Source</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((co) => {
                  const ps = people.filter((p) => p.companyId === co.id);
                  return (
                    <tr key={co.id}>
                      <td style={{ minWidth: 220 }}>
                        <Link href={`/leads/${co.id}`} className="primary">
                          {co.name}
                        </Link>
                        <div className="small muted">
                          {co.domain}
                          {co.city || co.state ? ` · ${[co.city, co.state].filter(Boolean).join(", ")}` : ""}
                        </div>
                        {supDomains.has(co.domain) && (
                          <div style={{ marginTop: 4 }}>
                            <Badge value="domain suppressed" tone="bad" />
                          </div>
                        )}
                      </td>
                      <td>{pretty(co.segmentId)}</td>
                      <td>
                        <Badge value={co.status} />
                        {co.status === "disqualified" && co.icpReason && <div className="small muted" style={{ marginTop: 4, maxWidth: 260 }}>{co.icpReason}</div>}
                      </td>
                      <td className="num">{co.icpScore ?? "-"}</td>
                      <td className="small">
                        {ps.length === 0 && <span className="muted">None yet</span>}
                        {ps.map((p) => (
                          <div key={p.id} className="row" style={{ gap: 6, flexWrap: "nowrap", marginBottom: 4 }}>
                            <span>{p.email}</span>
                            <Badge value={p.status} />
                          </div>
                        ))}
                      </td>
                      <td className="small">{pretty(co.source)}</td>
                      <td className="small muted" style={{ whiteSpace: "nowrap" }}>{when(co.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
