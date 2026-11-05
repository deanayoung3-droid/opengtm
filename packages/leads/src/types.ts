export interface CompanyCandidate {
  name: string;
  domain: string;
  website?: string;
  state?: string;
  city?: string;
  country?: string;
  companySize?: number;
  focusAreas?: string[];
  sourceRef?: string;
  people?: PersonCandidate[];
}

export interface PersonCandidate {
  email: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  sourceUrl?: string;
  /** Vendor's id for this person, used to buy their email later. */
  externalId?: string;
}

export interface DiscoverQuery {
  segmentId: string;
  keywords: string[];
  roles: string[];
  limit: number;
}

/**
 * A lead source. `termsAllowOutbound` must only be true once a human has checked
 * the source's terms permit using its data for internal outbound email.
 */
/** The vendor account has no credits left: stop this run and tell the team (upgrade, or wait for renewal). */
export class SourceOutOfCreditsError extends Error {}

export interface LeadSource {
  readonly name: string;
  readonly termsAllowOutbound: boolean;
  discoverCompanies(q: DiscoverQuery): Promise<CompanyCandidate[]>;
  findPeople(company: CompanyCandidate, roles: string[]): Promise<PersonCandidate[]>;
}
