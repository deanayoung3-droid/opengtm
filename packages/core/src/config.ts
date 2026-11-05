import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { NO_LOGOS, readLogos, type BrandLogos } from "./logo";

const proofPoint = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), text: z.string().min(1) }),
]);

const sender = z.object({
  name: z.string().default(""),
  title: z.string().default(""),
  reply_to: z.string().default(""),
});

export const businessSchema = z.object({
  company: z.object({
    name: z.string().min(1),
    site: z.url(),
    one_liner: z.string().min(1),
    thesis: z.string().min(1),
    strengths: z.array(z.string()).default([]),
    proof_points: z.array(proofPoint).default([]),
    banned_claims: z.array(z.string()).default([]),
    booking_link: z.string().default(""),
    physical_address: z.string().default(""),
    /** What we offer in the call to action, e.g. "a 2-minute video of the product" or "a free sample report". */
    offer: z.string().default(""),
    pricing: z.string().default(""),
    /** PNG logo for the email signature, relative to the config folder (e.g. "logo.png"); blank = no logo. */
    logo: z.string().default(""),
    /** Optional white version for mail apps in dark mode. */
    logo_dark: z.string().default(""),
  }),
  /** Competitors replies and emails may be compared against (names only; no claims about them). */
  competitors: z.array(z.string()).default([]),
  /** Facts reply drafts may use to answer questions (capabilities, integrations, trial terms). */
  facts: z.string().default(""),
  outreach: z
    .object({
      /** Project-wide writing instructions, like a brief to a copywriter. */
      instructions: z.string().default(""),
      /** Copied on every reply we send, so a real person sees each conversation. */
      reply_cc: z.array(z.email()).default([]),
      /** The one word the first email asks people to reply with to get the offer ("yes"). Saying yes should cost nothing. */
      cta_reply: z.string().min(1).max(20).default("yes"),
      /** What a reply to a hot lead steers toward after the offer, booked at the booking link. */
      demo_offer: z.string().default("a quick call with our team"),
      /** The answer to a plain yes, word for word ({{first_name}} is filled in); blank lets the model write it. */
      yes_reply: z.string().default(""),
      /** Subjects tested as version B of the first email, one per thread, used exactly as written. Empty = both versions let the writer name the recipient's work. */
      subject_lines_b: z.array(z.string().min(1).max(60)).default([]),
    })
    .prefault({}),
  senders: z.array(sender).default([]),
  icp: z.object({
    segments: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9_]+$/),
          description: z.string().min(1),
          keywords: z.array(z.string()).default([]),
        }),
      )
      .min(1),
    roles: z.array(z.string()).min(1),
    geo: z.array(z.string()).min(1),
    exclude_domains: z.array(z.string()).default([]),
  }),
  signals: z.array(z.string()).default([]),
});

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const engineSchema = z.object({
  caps: z.object({
    daily_send_cap: z.number().int().positive(),
    daily_spend_cap_usd: z.number().positive(),
    per_lead_llm_cap_usd: z.number().positive(),
    role_address_daily_cap: z.number().int().nonnegative(),
    allow_role_addresses: z.boolean(),
  }),
  qualify: z.object({
    threshold: z.number().int().min(0).max(100),
    /** Companies with more people than this are dropped (lead sources count all staff). */
    max_company_size: z.number().int().positive().default(20),
  }),
  leads: z
    .object({
      /** Most companies one discover run adds per campaign; the run asks for what the mailboxes need, split across campaigns. */
      companies_per_segment_per_run: z.number().int().positive().default(20),
      ai_ark: z
        .object({
          credit_usd: z.number().nonnegative().default(0.0098),
          max_credits_per_month: z.number().nonnegative().default(100),
          /** Day of the month the AI Ark plan renews (its credits reset then, not on the 1st). */
          renews_on_day: z.number().int().min(1).max(28).default(1),
          /** People Preview (1 credit a page) + one paid email lookup per new company, instead of 0.5 credits per person found. */
          preview: z.boolean().default(true),
          max_credits_per_run: z.number().positive().default(50),
          /** Buy only enough leads to keep this many days of first emails waiting (what the mailboxes can send), so paid leads never pile up. */
          stock_days: z.number().positive().default(3),
          /** Credits one emailable person costs on average (preview page share + email lookups, some without an email). */
          credits_per_person: z.number().positive().default(1.1),
          max_exports_per_company: z.number().int().positive().default(2),
          page_size: z.number().int().min(1).max(100).default(10),
          employee_min: z.number().int().positive().default(1),
          employee_max: z.number().int().positive().default(20),
          /** AI Ark industry names to search (empty = any industry; the ICP keywords still decide fit). */
          industries: z.array(z.string()).default([]),
          /** Titles searched after the ICP roles (lower priority at each company), to reach more companies. */
          extra_titles: z.array(z.string()).default([]),
          /** Bump whenever titles, company size or industries change, so the search starts over instead of skipping new matches. */
          search_version: z.number().int().positive().default(1),
        })
        .prefault({}),
    })
    .prefault({}),
  verify: z.object({
    provider: z.enum(["zerobounce", "mock"]),
    cost_per_check_usd: z.number().nonnegative(),
    trust_sources: z.array(z.string()).default([]),
  }),
  research: z.object({
    max_pages: z.number().int().positive(),
    min_facts_for_personalization: z.number().int().nonnegative(),
    user_agent: z.string(),
    request_delay_ms: z.number().int().nonnegative(),
  }),
  writer: z.object({
    max_regenerations: z.number().int().nonnegative(),
    min_words: z.number().int().positive(),
    /** Follow-ups can be shorter, like three-line nudges. */
    followup_min_words: z.number().int().positive().default(25),
    max_words: z.number().int().positive(),
    /** Words over max_words still accepted: the writer aims for max_words, models miscount by a few. */
    word_slack: z.number().int().nonnegative().default(10),
    critic_threshold: z.number().int().min(0).max(100),
  }),
  approval: z.object({
    require_first_n: z.number().int().nonnegative(),
    sample_rate: z.number().min(0).max(1),
    force_all: z.boolean(),
  }),
  sequence: z.object({
    steps: z.array(z.object({ step: z.number().int().positive(), day: z.number().int().nonnegative() })).min(1),
    one_contact_per_company: z.boolean(),
  }),
  ramp: z.object({
    tiers: z.array(z.object({ from_week: z.number().int().positive(), per_day: z.number().int().positive() })).min(1),
    hard_max_per_day: z.number().int().positive(),
    hold_below_health: z.number().int().min(0).max(100),
  }),
  timing: z.object({
    business_start: hhmm,
    business_end: hhmm,
    send_weekends: z.boolean(),
    send_days: z.array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])).optional(),
    jitter_min_s: z.number().int().nonnegative(),
    jitter_max_s: z.number().int().positive(),
  }),
  health: z.object({
    max_bounce_rate: z.number().positive(),
    bounce_min_sample: z.number().int().positive(),
    /** One bad address never pauses a mailbox by itself; it takes this many hard bounces and the rate. */
    bounce_min_count: z.number().int().positive().default(2),
    bounce_window_days: z.number().int().positive(),
    max_complaint_rate: z.number().positive(),
    min_seed_placement: z.number().min(0).max(1),
    seed_inboxes: z
      .array(z.object({ address: z.email(), provider: z.enum(["google", "microsoft"]), imap_env: z.string() }))
      .default([]),
  }),
  learning: z.object({
    auto_pause_min_sends: z.number().int().positive(),
    max_cost_per_positive_usd: z.number().positive(),
    min_sends_per_variant: z.number().int().positive(),
    significance: z.number().positive().max(0.5),
  }),
  replies: z.object({
    classify_min_confidence: z.number().min(0).max(1),
    retouch_days: z.number().int().positive(),
    require_reply_approval: z.boolean(),
    /** Drafted replies wait this long for a person, then send by themselves. */
    auto_reply: z.object({ enabled: z.boolean().default(true), delay_minutes: z.number().int().nonnegative().default(240) }).prefault({}),
  }),
  alerts: z.object({ channels: z.array(z.enum(["console", "team_email", "ntfy", "slack", "email", "sms"])).min(1) }),
  savings: z
    .object({
      /** What we would otherwise pay for: each vendor's plan, priced per email sent and/or per month. */
      replaces: z
        .array(z.object({ name: z.string(), plan: z.string().default(""), per_email_usd: z.number().nonnegative().default(0), monthly_usd: z.number().nonnegative().default(0) }))
        .default([]),
      /** What we pay every month to run it ourselves (on top of metered AI, data and verification spend). */
      our_fixed: z.array(z.object({ name: z.string(), monthly_usd: z.number().nonnegative() })).default([]),
      /** Day we started paying for our own setup; all-time savings count from here. */
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2026-10-23"),
    })
    .prefault({}),
});

const route = z.object({
  provider: z.enum(["anthropic", "openai", "gemini", "local"]),
  model: z.string(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  max_tokens: z.number().int().positive().optional(),
});

export const TASKS = [
  "icp_score",
  "lead_tagging",
  "research_extract",
  "write_email",
  "critic",
  "compliance_check",
  "reply_classify",
  "reply_classify_escalate",
  "reply_draft",
  "segment_insights",
  "lead_brief",
] as const;
export type TaskName = (typeof TASKS)[number];

/** Classification-only tasks that can run on a decision model (Jev) instead of an LLM. */
export const DECISION_TASKS = ["reply_classify", "lead_tagging"] as const;
export type DecisionTaskName = (typeof DECISION_TASKS)[number];

const decisionRoute = z.object({ provider: z.enum(["jev"]), model: z.string() });

export const llmSchema = z.object({
  providers: z.object({
    anthropic: z.object({ api_key_env: z.string() }).optional(),
    openai: z.object({ api_key_env: z.string() }).optional(),
    gemini: z.object({ api_key_env: z.string() }).optional(),
    local: z.object({ base_url_env: z.string(), api_key_env: z.string() }).optional(),
    jev: z.object({ api_key_env: z.string() }).optional(),
  }),
  pricing: z.record(z.string(), z.object({ in: z.number().nonnegative(), out: z.number().nonnegative() })),
  retries: z.number().int().nonnegative(),
  tasks: z.object(Object.fromEntries(TASKS.map((t) => [t, z.array(route).min(1)])) as Record<TaskName, z.ZodArray<typeof route>>),
  /** Optional decision-model routes; tasks fall back to their LLM route when absent or unsure. */
  decisions: z
    .object(Object.fromEntries(DECISION_TASKS.map((t) => [t, z.array(decisionRoute).optional()])) as Record<DecisionTaskName, z.ZodOptional<z.ZodArray<typeof decisionRoute>>>)
    .default({}),
});

export type LlmRoute = z.infer<typeof route>;
export type DecisionRoute = z.infer<typeof decisionRoute>;
export type BusinessConfig = z.infer<typeof businessSchema>;
export type EngineConfig = z.infer<typeof engineSchema>;
export type LlmConfig = z.infer<typeof llmSchema>;

export interface ProofPoint {
  id: string;
  text: string;
}

export interface Config {
  business: BusinessConfig;
  engine: EngineConfig;
  llm: LlmConfig;
  proofPoints: ProofPoint[];
  /** The signature logo files, read once at startup (see company.logo). */
  logos: BrandLogos;
}

/** Replace ${VAR} with process env values. Unset vars become "". */
function interpolateEnv(raw: string, env: NodeJS.ProcessEnv): string {
  return raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? "");
}

function readYaml(file: string, env: NodeJS.ProcessEnv): unknown {
  return parseYaml(interpolateEnv(readFileSync(file, "utf8"), env));
}

export class ConfigError extends Error {}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, file: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(`${file} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function buildConfig(raw: { business: unknown; engine: unknown; llm: unknown }): Config {
  const business = parseOrThrow(businessSchema, raw.business, "business.yaml");
  const engine = parseOrThrow(engineSchema, raw.engine, "engine.yaml");
  const llm = parseOrThrow(llmSchema, raw.llm, "llm.yaml");
  const proofPoints = business.company.proof_points.map((p, i) =>
    typeof p === "string" ? { id: `pp${i + 1}`, text: p } : p,
  );
  const ids = new Set(proofPoints.map((p) => p.id));
  if (ids.size !== proofPoints.length) throw new ConfigError("business.yaml: proof_points ids must be unique");
  if (engine.writer.min_words > engine.writer.max_words) throw new ConfigError("engine.yaml: writer.min_words > max_words");
  if (engine.timing.jitter_min_s > engine.timing.jitter_max_s) throw new ConfigError("engine.yaml: jitter_min_s > jitter_max_s");
  if (business.icp.geo.some((g) => g !== "US")) throw new ConfigError("business.yaml: only US geo is allowed at launch");
  return { business, engine, llm, proofPoints, logos: NO_LOGOS };
}

export function findRepoRoot(start = process.cwd()): string {
  let dir = start;
  for (;;) {
    try {
      readFileSync(path.join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return start;
      dir = parent;
    }
  }
}

/** config/business.yaml, or the shipped example (a made-up company that can't send) until setup writes yours. */
export function businessFile(dir: string): string {
  const own = path.join(dir, "business.yaml");
  return existsSync(own) ? own : path.join(dir, "business.example.yaml");
}

export function loadConfig(opts: { dir?: string; env?: NodeJS.ProcessEnv } = {}): Config {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? env.GTM_CONFIG_DIR ?? path.join(findRepoRoot(), "config");
  const config = buildConfig({
    business: readYaml(businessFile(dir), env),
    engine: readYaml(path.join(dir, "engine.yaml"), env),
    llm: readYaml(path.join(dir, "llm.yaml"), env),
  });
  return { ...config, logos: readLogos(dir, config.business.company.logo, config.business.company.logo_dark) };
}

export interface HumanTodo {
  field: string;
  blocksSending: boolean;
  note: string;
}

/** Fields a human must fill (CLAUDE.md section 16). Sending is refused while any blocking item is open. */
export function humanTodos(config: Config): HumanTodo[] {
  const todos: HumanTodo[] = [];
  const c = config.business.company;
  if (!c.physical_address.trim())
    todos.push({ field: "company.physical_address", blocksSending: true, note: "CAN-SPAM requires a postal address in every email" });
  if (!config.business.senders.some((s) => s.name.trim()))
    todos.push({ field: "senders", blocksSending: true, note: "At least one real, consenting team member as sender" });
  if (config.proofPoints.length === 0)
    todos.push({ field: "company.proof_points", blocksSending: false, note: "Without proof points emails can only use researched facts" });
  if (!c.booking_link.trim())
    todos.push({ field: "company.booking_link", blocksSending: false, note: "Needed for hot-lead reply drafts" });
  if (c.banned_claims.length === 0)
    todos.push({ field: "company.banned_claims", blocksSending: false, note: "List anything we must never say" });
  if (config.engine.health.seed_inboxes.length === 0)
    todos.push({ field: "health.seed_inboxes", blocksSending: false, note: "Owned Gmail/Outlook inboxes for placement tests" });
  return todos;
}

export function sendingBlockers(config: Config): HumanTodo[] {
  return humanTodos(config).filter((t) => t.blocksSending);
}
