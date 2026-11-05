import { companies, suppression, type Db } from "@opengtm/core";
import { isNotNull } from "drizzle-orm";

const SUFFIXES = /\b(llc|pllc|plc|pc|p c|pa|p a|llp|lllp|ltd|inc|incorporated|corp|corporation|co|company|lp|the)\b/g;
const TAILS = ["group", "co", "company", "hq", "inc", "services", "solutions", "partners"];

/** The first label of a domain, letters and digits only: "brightpathgroup.com" -> "brightpathgroup". */
export const domainRoot = (domain: string) => (domain.toLowerCase().replace(/^www\./, "").split(".")[0] ?? "").replace(/[^a-z0-9]/g, "");

/**
 * The website names a company is likely to use: "Bright Path Group, LLC" -> brightpathgroup, brightpath,
 * brightpathco, ... Used to recognize a company from its name alone, before paying for its details.
 */
export function nameKeys(name: string): string[] {
  const words = ` ${name.toLowerCase().replace(/&/g, " and ").replace(/[.,]/g, " ")} `.replace(SUFFIXES, " ");
  const squash = (s: string) => s.replace(/[^a-z0-9]/g, "");
  const base = squash(words);
  if (base.length < 4) return [];
  const core = TAILS.reduce((b, t) => (b.endsWith(t) && b.length - t.length >= 4 ? b.slice(0, -t.length) : b), base);
  return [...new Set([base, core, ...TAILS.map((t) => core + t), squash(words.replace(/\band\b/g, " "))])].filter((k) => k.length >= 4);
}

/**
 * "Do we already know this company?" from what a lead vendor shows before charging: its own company id and the
 * company's name. True for companies already in the database (same vendor id, or a name matching a known website)
 * and for companies on the do-not-contact list (e.g. ones another tool already emailed). Loaded once per run.
 */
export async function knownCompanyCheck(db: Db): Promise<(f: { aiArkId: string; name: string }) => Promise<boolean>> {
  const [known, blocked] = await Promise.all([
    db.select({ ref: companies.sourceRef, domain: companies.domain }).from(companies),
    db.select({ domain: suppression.domain }).from(suppression).where(isNotNull(suppression.domain)),
  ]);
  const refs = new Set(known.map((f) => f.ref).filter(Boolean));
  const roots = new Set([...known.map((f) => f.domain), ...blocked.map((b) => b.domain)].filter((d): d is string => !!d).map(domainRoot).filter((r) => r.length >= 4));
  return async ({ aiArkId, name }) => refs.has(`ai_ark:${aiArkId}`) || nameKeys(name).some((k) => roots.has(k));
}
