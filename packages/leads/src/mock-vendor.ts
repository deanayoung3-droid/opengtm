import type { CompanyCandidate, DiscoverQuery, LeadSource, PersonCandidate } from "./types";

const STATES = ["TX", "FL", "CA", "NY", "IL", "GA", "OH", "NC", "AZ", "CO"];
const FIRST = ["Maria", "James", "Priya", "Daniel", "Aisha", "Robert", "Elena", "Marcus", "Sarah", "Kevin"];
const LAST = ["Alvarez", "Nguyen", "Patel", "Brooks", "Okafor", "Kim", "Russo", "Bennett", "Cohen", "Hart"];
const TITLES = ["Managing Partner", "Owner", "Partner", "Office Manager", "Company Administrator"];

/**
 * Deterministic fake vendor used in tests and local dry runs. Company i gets
 * one or two people. Some rows are intentionally bad so filters get exercised:
 * every 7th company is large (fails ICP), every 10th has an email the mock verifier
 * marks invalid, every 9th is non-US.
 */
export class MockVendorSource implements LeadSource {
  readonly name = "mock_vendor";
  readonly termsAllowOutbound = true;
  constructor(private count = 50) {}

  async discoverCompanies(q: DiscoverQuery): Promise<CompanyCandidate[]> {
    const out: CompanyCandidate[] = [];
    const n = Math.min(q.limit, this.count);
    for (let i = 0; i < n; i++) {
      const last = LAST[i % LAST.length]!;
      const area = q.keywords[i % Math.max(1, q.keywords.length)] ?? "services";
      const domain = `${last.toLowerCase()}${i}-${q.segmentId.replace(/_/g, "")}.biz.example`;
      out.push({
        name: `${last} ${area.replace(/\b\w/g, (c) => c.toUpperCase())} Law ${i}`,
        domain,
        website: `https://${domain}`,
        state: STATES[i % STATES.length],
        city: "Springfield",
        country: i % 9 === 8 ? "CA-ON" : "US",
        companySize: i % 7 === 6 ? 85 : 1 + (i % 9),
        focusAreas: [area],
        sourceRef: `mock:${q.segmentId}:${i}`,
      });
    }
    return out;
  }

  async findPeople(company: CompanyCandidate): Promise<PersonCandidate[]> {
    const i = Number(company.sourceRef?.split(":").pop() ?? 0);
    const domain = company.domain;
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[i % LAST.length]!;
    const people: PersonCandidate[] = [
      {
        email: i % 10 === 3 ? `invalid.${first.toLowerCase()}@${domain}` : `${first.toLowerCase()}@${domain}`,
        firstName: first,
        lastName: last,
        title: TITLES[i % TITLES.length],
      },
    ];
    if (i % 4 === 0) people.push({ email: `info@${domain}`, title: "Front desk" });
    if (i % 5 === 0) people.push({ email: `${first.toLowerCase()}@${domain}`.toUpperCase(), firstName: first, lastName: last });
    return people;
  }
}
