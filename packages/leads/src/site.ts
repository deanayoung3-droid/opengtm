import { domainOf, normalizeDomain } from "@opengtm/core";
import { extractLinks, extractMailtos, pickResearchPages, type PageFetcher } from "@opengtm/research";
import type { CompanyCandidate, DiscoverQuery, LeadSource, PersonCandidate } from "./types";

// CAN-SPAM treats harvesting addresses from a site that says it does not give
// them out for email as an aggravated violation. If a page says so, skip the company.
const NO_HARVEST_RE = /(not (?:be )?used for (?:unsolicited|commercial|marketing)|do not (?:send|use).{0,40}(?:unsolicited|marketing|solicitation)|no solicitation|not consent to (?:receive )?(?:unsolicited|commercial) e-?mail)/i;

/**
 * Finds published company emails (mailto links) on the company's own site.
 * Disabled for outbound until a human confirms it fits your policy.
 */
export class CompanySiteContactsSource implements LeadSource {
  readonly name = "firm_site";
  constructor(
    private fetcher: PageFetcher,
    readonly termsAllowOutbound = false,
  ) {}

  async discoverCompanies(_q: DiscoverQuery): Promise<CompanyCandidate[]> {
    return []; // enrichment-only source
  }

  async findPeople(company: CompanyCandidate): Promise<PersonCandidate[]> {
    const home = await this.fetcher.fetch(company.website ?? `https://${company.domain}`);
    if (!home) return [];
    const candidates = [home];
    const links = extractLinks(home.html, home.url).filter((l) => /contact|team|staff|people|about|leadership/i.test(`${l.url} ${l.text}`));
    for (const url of pickResearchPages(links, 3)) {
      const p = await this.fetcher.fetch(url);
      if (p) candidates.push(p);
    }
    if (candidates.some((p) => NO_HARVEST_RE.test(p.text))) return [];
    const domain = normalizeDomain(company.domain);
    const out = new Map<string, PersonCandidate>();
    for (const p of candidates) {
      for (const m of extractMailtos(p.html)) {
        if (domainOf(m.email) !== domain) continue;
        out.set(m.email.toLowerCase(), { email: m.email, sourceUrl: p.url });
      }
    }
    return [...out.values()];
  }
}
