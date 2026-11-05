import { readFileSync } from "node:fs";
import { csvRows, normalizeDomain } from "@opengtm/core";
import type { CompanyCandidate, DiscoverQuery, LeadSource, PersonCandidate } from "./types";

/** CSV with a header row -> one object per row, keys lowercased with spaces as underscores. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = csvRows(text);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/**
 * Imports a vendor export or hand-built list. Columns:
 * company,domain,website,state,city,company_size,focus_areas(; separated),first_name,last_name,title,email
 * One row per person; rows sharing a domain are grouped into one company.
 */
export class CsvLeadSource implements LeadSource {
  readonly name: string;
  private companies: CompanyCandidate[];

  constructor(
    csvText: string,
    opts: { name?: string; termsAllowOutbound: boolean },
  ) {
    this.name = opts.name ?? "csv_import";
    this.termsAllowOutbound = opts.termsAllowOutbound;
    const byDomain = new Map<string, CompanyCandidate>();
    for (const r of parseCsv(csvText)) {
      const domain = normalizeDomain(r.domain || r.website || (r.email ?? "").split("@")[1] || "");
      if (!domain) continue;
      let c = byDomain.get(domain);
      if (!c) {
        c = {
          name: r.company || domain,
          domain,
          website: r.website || `https://${domain}`,
          state: r.state || undefined,
          city: r.city || undefined,
          companySize: r.company_size ? Number(r.company_size) : undefined,
          focusAreas: r.focus_areas ? r.focus_areas.split(/[;|]/).map((s) => s.trim()).filter(Boolean) : [],
          sourceRef: `${this.name}:${domain}`,
          people: [],
        };
        byDomain.set(domain, c);
      }
      if (r.email) {
        c.people!.push({ email: r.email, firstName: r.first_name || undefined, lastName: r.last_name || undefined, title: r.title || undefined });
      }
    }
    this.companies = [...byDomain.values()];
  }

  readonly termsAllowOutbound: boolean;

  static fromFile(file: string, opts: { name?: string; termsAllowOutbound: boolean }): CsvLeadSource {
    return new CsvLeadSource(readFileSync(file, "utf8"), opts);
  }

  async discoverCompanies(q: DiscoverQuery): Promise<CompanyCandidate[]> {
    return this.companies.slice(0, q.limit);
  }

  async findPeople(company: CompanyCandidate): Promise<PersonCandidate[]> {
    return company.people ?? [];
  }
}
