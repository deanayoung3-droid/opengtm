import { businessSchema, ConfigError, type BusinessConfig, type Config } from "./config";
import type { Db } from "./db/client";
import { getSetting, setSetting } from "./settings";

/**
 * Project docs: everything the agent knows about your company (profile, offer, pricing, proof,
 * competitors, reply facts, campaigns, writing instructions, reply Cc), edited in the dashboard.
 * Stored as one override on top of config/business.yaml, which stays the starting point.
 */
export const PROJECT_DOCS_KEY = "project_docs";

export type ProjectDocs = {
  company?: Partial<BusinessConfig["company"]>;
  senders?: BusinessConfig["senders"];
  icp?: Partial<Pick<BusinessConfig["icp"], "segments" | "roles" | "exclude_domains">>;
  competitors?: string[];
  facts?: string;
  outreach?: Partial<BusinessConfig["outreach"]>;
};

export async function loadProjectDocs(db: Db): Promise<ProjectDocs> {
  return getSetting<ProjectDocs>(db, PROJECT_DOCS_KEY, {});
}

/** A field left blank in the dashboard means "not set here", so the value from config/business.yaml shows through. */
const withoutBlanks = <T extends object>(o: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => !(typeof v === "string" && v.trim() === ""))) as Partial<T>;

/** Merge the docs over the yaml config and re-validate; proof point ids are rebuilt the same way. */
export function applyProjectDocs(base: Config, docs: ProjectDocs): Config {
  const merged = {
    ...base.business,
    ...(docs.senders ? { senders: docs.senders } : {}),
    ...(docs.competitors ? { competitors: docs.competitors } : {}),
    ...(docs.facts !== undefined ? { facts: docs.facts } : {}),
    company: { ...base.business.company, ...withoutBlanks(docs.company) },
    icp: { ...base.business.icp, ...(docs.icp ?? {}) },
    outreach: { ...base.business.outreach, ...withoutBlanks(docs.outreach) },
  };
  const parsed = businessSchema.safeParse(merged);
  if (!parsed.success) throw new ConfigError(`project docs: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const business = parsed.data;
  const proofPoints = business.company.proof_points.map((p, i) => (typeof p === "string" ? { id: `pp${i + 1}`, text: p } : p));
  if (new Set(proofPoints.map((p) => p.id)).size !== proofPoints.length) throw new ConfigError("project docs: proof point ids must be unique");
  return { ...base, business, proofPoints };
}

/** Validate and store a change (merged with what is already saved). Throws ConfigError on bad input. */
export async function saveProjectDocs(db: Db, base: Config, patch: ProjectDocs, actor: string): Promise<Config> {
  const current = await loadProjectDocs(db);
  const next: ProjectDocs = {
    ...current,
    ...patch,
    company: { ...(current.company ?? {}), ...(patch.company ?? {}) },
    icp: { ...(current.icp ?? {}), ...(patch.icp ?? {}) },
    outreach: { ...(current.outreach ?? {}), ...(patch.outreach ?? {}) },
  };
  const config = applyProjectDocs(base, next); // throws before anything is stored
  await setSetting(db, PROJECT_DOCS_KEY, next, actor);
  return config;
}
