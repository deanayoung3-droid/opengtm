import { normalizeDomain } from "@opengtm/core";
import { SourceOutOfCreditsError, type CompanyCandidate, type DiscoverQuery, type LeadSource, type PersonCandidate } from "./types";

/** Where the next search page per segment is remembered, so we never pay twice for the same results. */
export interface CursorStore {
  get(key: string): Promise<number | null>;
  set(key: string, value: number): Promise<void>;
}

export class MemoryCursorStore implements CursorStore {
  private m = new Map<string, number>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: number) {
    this.m.set(k, v);
  }
}

export interface AiArkOptions {
  apiKey: string;
  /** Set only after a human has read AI Ark's terms for outbound use (AI_ARK_TERMS_OK=1). */
  termsAllowOutbound: boolean;
  maxCreditsPerRun: number;
  maxExportsPerCompany: number;
  /** Fixed search page size. The saved cursor is a page number, so the size must never change between runs. */
  pageSize?: number;
  employeeMin: number;
  employeeMax: number;
  industries: string[];
  /** Titles searched after the ICP roles (e.g. "founder"): lower priority at each company, many more companies found. */
  extraTitles?: string[];
  /** Bump when titles, company size or industries change: the saved search position starts over for the new filter. */
  searchVersion?: number;
  cursor?: CursorStore;
  onSpend?: (credits: number, note: string) => void | Promise<void>;
  /**
   * Credit-saving mode: find people with People Preview (1 credit per page of 100, no emails) and pay
   * only for one email lookup per new company (1 credit when found, nothing when not).
   */
  preview?: boolean;
  /** Companies we already have or must not contact, checked before paying for a lookup (preview mode). */
  knownCompany?: (f: { aiArkId: string; name: string }) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

// ai-ark.com/pricing: a person profile is 0.5 credit, adding their verified email is 0.5 more (1 total).
const SEARCH_CREDIT = 0.5; // per returned person
const EXPORT_CREDIT = 0.5; // per email found; 0 when none
const PREVIEW_PAGE_CREDIT = 1; // People Preview: flat per page, up to 100 people
const PREVIEW_SIZE = 100;
const LOOKUP_CREDIT = 1; // export single by id after a preview: profile 0.5 + email 0.5, 0 when no email

export class AiArkError extends Error {}

/**
 * AI Ark (docs.ai-ark.com). People search filtered to small US companies in the
 * segment's keywords and our ICP titles; then a verified email is exported
 * for the best-ranked person per company only.
 */
export class AiArkSource implements LeadSource {
  readonly name = "ai_ark";
  creditsUsed = 0;
  /** Email lookups that failed after retries this run (company skipped, nothing charged). */
  failures: string[] = [];
  /** Preview mode: companies skipped before paying (already known or do-not-contact), and lookups with no email. */
  skippedKnown = 0;
  notFound = 0;
  private seenCompanies = new Set<string>();
  constructor(private opts: AiArkOptions) {}

  get termsAllowOutbound(): boolean {
    return this.opts.termsAllowOutbound;
  }

  private budgetLeft(): number {
    return this.opts.maxCreditsPerRun - this.creditsUsed;
  }

  /** ICP roles first (preferred at each company), then the wider titles. */
  private titles(roles: string[]): string[] {
    const extra = (this.opts.extraTitles ?? []).filter((t) => !roles.some((r) => r.toLowerCase() === t.toLowerCase()));
    return [...roles, ...extra];
  }

  private rankBy(roles: string[]) {
    const titles = this.titles(roles).map((t) => t.toLowerCase());
    return (title?: string) => {
      const t = (title ?? "").toLowerCase();
      const i = titles.findIndex((r) => t.includes(r));
      return i === -1 ? titles.length : i;
    };
  }

  /** Where a campaign's search is up to. A new search version starts at page 0 (companies we know are skipped for free). */
  private cursorKey(kind: "page" | "preview", segmentId: string): string {
    const v = this.opts.searchVersion ?? 1;
    return v > 1 ? `ai_ark:${kind}:v${v}:${segmentId}` : `ai_ark:${kind}:${segmentId}`;
  }

  private async charge(credits: number, note: string) {
    if (credits <= 0) return;
    this.creditsUsed += credits;
    await this.opts.onSpend?.(credits, note);
  }

  private async post(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    await sleep(250); // documented limit: 5 req/s overall
    // Email export is rate-limited harder than search: on 429/5xx wait (Retry-After if given) and try again.
    for (let attempt = 0; ; attempt++) {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl ?? "https://api.ai-ark.com"}${path}`, {
        method: "POST",
        headers: { "X-TOKEN": this.opts.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return { status: 404, json: null };
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        if (res.status === 402 || /credit|balance|quota|insufficient|upgrade/i.test(text)) throw new SourceOutOfCreditsError(`AI Ark is out of credits (${res.status}: ${text})`);
        throw new AiArkError(`ai-ark ${path} ${res.status}: ${text}`);
      }
      return { status: res.status, json: await res.json() };
    }
  }

  searchBody(q: DiscoverQuery, page: number, size: number) {
    return {
      account: {
        industries: { any: { include: { mode: "WORD", content: this.opts.industries } } },
        employeeSize: { type: "RANGE", range: [{ start: this.opts.employeeMin, end: this.opts.employeeMax }] },
        location: { any: { include: ["United States"] } },
        keyword: {
          any: {
            include: {
              sources: [
                { mode: "SMART", source: "KEYWORD" },
                { mode: "SMART", source: "DESCRIPTION" },
                { mode: "SMART", source: "NAME" },
              ],
              content: q.keywords,
            },
          },
        },
      },
      contact: {
        experience: { latest: { title: { any: { include: { mode: "SMART", content: this.titles(q.roles) } } } } },
        location: { any: { include: ["United States"] } },
      },
      page,
      size,
    };
  }

  async discoverCompanies(q: DiscoverQuery): Promise<CompanyCandidate[]> {
    if (this.opts.preview) return this.discoverViaPreview(q);
    const cursor = this.opts.cursor ?? new MemoryCursorStore();
    const key = this.cursorKey("page", q.segmentId);
    let page = (await cursor.get(key)) ?? 0;
    const companies = new Map<string, CompanyCandidate>();

    const size = Math.min(100, this.opts.pageSize ?? 10);
    while (companies.size < q.limit && this.budgetLeft() >= SEARCH_CREDIT * size) {
      const { json } = await this.post("/api/developer-portal/v1/people", this.searchBody(q, page, size));
      const people: any[] = json?.content ?? [];
      await this.charge(people.length * SEARCH_CREDIT, `search ${q.segmentId} p${page}`);
      for (const p of people) {
        const domain = normalizeDomain(p?.company?.link?.domain ?? "");
        if (!domain) continue;
        let company = companies.get(domain);
        if (!company) {
          // The company's HQ is the reliable address (a person's location is often just a metro region).
          const hq = p?.company?.location?.headquarter;
          const country = hq?.country ?? p?.location?.country;
          company = {
            name: p?.company?.summary?.name ?? domain,
            domain,
            website: `https://${domain}`,
            state: hq?.state ?? p?.location?.state ?? undefined,
            city: hq?.city ?? p?.location?.city ?? undefined,
            country: !country || country === "United States" ? "US" : country,
            companySize: p?.company?.summary?.staff?.total ?? undefined,
            // The search matched this segment's practice keywords; research confirms on the company's site.
            focusAreas: q.keywords.slice(0, 1),
            sourceRef: `ai_ark:${p?.company?.id ?? domain}`,
            people: [],
          };
          companies.set(domain, company);
        }
        company.people!.push({
          email: "",
          firstName: p?.profile?.first_name ?? undefined,
          lastName: p?.profile?.last_name ?? undefined,
          title: p?.profile?.title ?? p?.profile?.headline ?? undefined,
          sourceUrl: p?.link?.linkedin ?? undefined,
          externalId: p?.id,
        });
      }
      page++;
      const lastPage = people.length < size || (typeof json?.totalPages === "number" && page >= json.totalPages);
      await cursor.set(key, page);
      if (lastPage) break; // segment exhausted for these filters; widen filters to get more
    }
    // Keep every company on the pages we paid for; the cursor has already moved past them.
    return [...companies.values()];
  }

  /**
   * Preview mode: one cheap page of people, grouped by company; for each company we don't know yet, look up the
   * best-ranked person's email (title order follows the ICP roles) and stop at the first one found. The
   * company's website comes with the lookup. The cursor only moves past a page once every company on it was
   * handled, so a run that stops halfway picks up the rest next time.
   */
  private async discoverViaPreview(q: DiscoverQuery): Promise<CompanyCandidate[]> {
    const cursor = this.opts.cursor ?? new MemoryCursorStore();
    const key = this.cursorKey("preview", q.segmentId);
    // Start where the older per-person search left off (it used pages of pageSize).
    let page = (await cursor.get(key)) ?? Math.floor((((await cursor.get(this.cursorKey("page", q.segmentId))) ?? 0) * (this.opts.pageSize ?? 10)) / PREVIEW_SIZE);
    const rank = this.rankBy(q.roles);
    const companies: CompanyCandidate[] = [];

    while (companies.length < q.limit && this.budgetLeft() >= PREVIEW_PAGE_CREDIT + LOOKUP_CREDIT) {
      const { json } = await this.post("/api/developer-portal/v1/people/preview", this.searchBody(q, page, PREVIEW_SIZE));
      const people: any[] = json?.content ?? [];
      await this.charge(PREVIEW_PAGE_CREDIT, `preview ${q.segmentId} p${page}`);
      const byCompany = new Map<string, any[]>();
      for (const p of people) {
        const id = p?.company?.id;
        if (id) byCompany.set(id, [...(byCompany.get(id) ?? []), p]);
      }

      let finished = true;
      for (const [vendorCompanyId, staff] of byCompany) {
        if (companies.length >= q.limit || this.budgetLeft() < LOOKUP_CREDIT) {
          finished = false;
          break;
        }
        if (this.seenCompanies.has(vendorCompanyId)) continue;
        this.seenCompanies.add(vendorCompanyId);
        const name = String(staff[0]?.company?.summary?.name ?? "");
        if (await this.opts.knownCompany?.({ aiArkId: vendorCompanyId, name })) {
          this.skippedKnown++;
          continue;
        }
        const ranked = [...staff].sort((a, b) => rank(a?.profile?.title) - rank(b?.profile?.title));
        for (const p of ranked.slice(0, this.opts.maxExportsPerCompany)) {
          if (this.budgetLeft() < LOOKUP_CREDIT) break;
          let res: { status: number; json: any };
          try {
            res = await this.post("/api/developer-portal/v1/people/export/single", { id: p.id });
          } catch (err) {
            if (err instanceof SourceOutOfCreditsError) throw err;
            this.failures.push(`${name}: ${(err as Error).message}`);
            break;
          }
          if (res.status === 404) {
            this.notFound++; // no email: not charged
            continue;
          }
          const outputs: any[] = res.json?.email?.output ?? [];
          if (outputs.some((o) => o?.found !== false && o?.address)) await this.charge(LOOKUP_CREDIT, `email ${name}`);
          const hit = outputs.find((o) => o?.address && o?.found !== false && !/invalid|unknown|risky/i.test(String(o?.status ?? "")));
          if (!hit) continue;
          const email = String(hit.address);
          const domain = normalizeDomain(res.json?.company?.link?.domain ?? email.split("@")[1] ?? "");
          if (!domain) continue;
          const hq = p?.company?.location?.headquarter ?? res.json?.company?.location?.headquarter;
          const country = hq?.country ?? p?.location?.country;
          companies.push({
            name: name || domain,
            domain,
            website: res.json?.company?.link?.website ?? `https://${domain}`,
            state: hq?.state ?? p?.location?.state ?? undefined,
            city: hq?.city ?? p?.location?.city ?? undefined,
            country: !country || country === "United States" ? "US" : country,
            companySize: p?.company?.summary?.staff?.total ?? undefined,
            focusAreas: q.keywords.slice(0, 1),
            sourceRef: `ai_ark:${vendorCompanyId}`,
            people: [
              {
                email,
                firstName: res.json?.profile?.first_name ?? p?.profile?.first_name ?? undefined,
                lastName: res.json?.profile?.last_name ?? undefined,
                title: res.json?.profile?.title ?? p?.profile?.title ?? undefined,
                sourceUrl: res.json?.link?.linkedin ?? undefined,
                externalId: p.id,
              },
            ],
          });
          break;
        }
      }

      const lastPage = people.length < PREVIEW_SIZE || (typeof json?.totalPages === "number" && page + 1 >= json.totalPages);
      if (finished) page++;
      await cursor.set(key, page);
      if (!finished || lastPage) break;
    }
    return companies;
  }

  /** Export a verified email for the best-ranked person at the company; stop at the first one found. */
  async findPeople(company: CompanyCandidate, roles: string[]): Promise<PersonCandidate[]> {
    // Preview mode looked the email up already, with the company.
    if (company.people?.some((p) => p.email)) return company.people.filter((p) => p.email);
    const rank = this.rankBy(roles);
    const ranked = (company.people ?? []).filter((p) => p.externalId).sort((a, b) => rank(a.title) - rank(b.title));
    let exports = 0;
    for (const p of ranked) {
      if (exports >= this.opts.maxExportsPerCompany || this.budgetLeft() < EXPORT_CREDIT) break;
      exports++;
      let res: { status: number; json: any };
      try {
        res = await this.post("/api/developer-portal/v1/people/export/single", { id: p.externalId });
      } catch (err) {
        if (err instanceof SourceOutOfCreditsError) throw err;
        // One company failing (still rate-limited after retries) must not sink the whole run; nothing was charged.
        this.failures.push(`${company.domain}: ${(err as Error).message}`);
        return [];
      }
      const { status, json } = res;
      if (status === 404) continue; // no email found: not charged
      const outputs: any[] = json?.email?.output ?? [];
      const hit = outputs.find((o) => o?.address && o?.found !== false && !/invalid|unknown|risky/i.test(String(o?.status ?? "")));
      if (!hit) continue;
      await this.charge(EXPORT_CREDIT, `email ${company.domain}`);
      return [{ ...p, email: String(hit.address) }];
    }
    return [];
  }
}
