import { teamDay } from "./clock";
import type { EngineConfig } from "./config";

/**
 * What running our own tools saves versus the plans we would otherwise pay for (engine.savings):
 * each replaced vendor's price for the emails we actually sent plus its monthly fee, minus what we
 * really paid (metered AI, data and verification spend, plus our fixed monthly costs spread evenly
 * over the days). Can be negative on days we send little, which is the honest answer.
 */
export interface Savings {
  /** "Tool A", or "Tool A + Tool B" when several plans are replaced. */
  compareTo: string;
  vendors: { name: string; plan: string; total: number }[];
  /** Replaced plans' combined price for one email. */
  perEmail: number;
  theirs: number[];
  ours: number[];
  saved: number[];
  total: { theirs: number; ours: number; saved: number; emails: number };
}

type SavingsConfig = EngineConfig["savings"];

const DEFAULTS: SavingsConfig = {
  replaces: [],
  our_fixed: [],
  since: "2026-10-23",
};

const cents = (v: number) => Math.round(v * 100) / 100;
const sum = (a: number[]) => cents(a.reduce((t, v) => t + v, 0));

export function savingsConfig(engine: Partial<Pick<EngineConfig, "savings">>): SavingsConfig {
  // A config loaded before this block existed (or an old shape) falls back rather than breaking a page.
  const s = engine.savings as Partial<SavingsConfig> | undefined;
  return s?.replaces && s.our_fixed ? (s as SavingsConfig) : DEFAULTS;
}

/** `days` (YYYY-MM-DD, one per value) lets fixed costs start on the savings start date, not before it. */
export function savingsByDay(engine: Partial<Pick<EngineConfig, "savings">>, sentPerDay: number[], spendPerDay: number[], days?: string[]): Savings {
  const s = savingsConfig(engine);
  const fixed = s.our_fixed.reduce((t, f) => t + f.monthly_usd, 0) / 30;
  const fixedOn = (i: number) => (days?.[i] && days[i]! < s.since ? 0 : fixed);
  const vendorDay = (v: SavingsConfig["replaces"][number], n: number) => n * v.per_email_usd + v.monthly_usd / 30;
  const theirs = sentPerDay.map((n) => cents(s.replaces.reduce((t, v) => t + vendorDay(v, n), 0)));
  const ours = sentPerDay.map((_, i) => cents((spendPerDay[i] ?? 0) + fixedOn(i)));
  const saved = theirs.map((t, i) => cents(t - ours[i]!));
  return {
    compareTo: s.replaces.map((v) => v.name).join(" + "),
    vendors: s.replaces.map((v) => ({ name: v.name, plan: v.plan, total: sum(sentPerDay.map((n) => vendorDay(v, n))) })),
    perEmail: s.replaces.reduce((t, v) => t + v.per_email_usd, 0),
    theirs,
    ours,
    saved,
    total: { theirs: sum(theirs), ours: sum(ours), saved: sum(saved), emails: sentPerDay.reduce((t, v) => t + v, 0) },
  };
}

/** Every day from the savings start date through today (team time zone), as YYYY-MM-DD. */
export function savingsDays(engine: Partial<Pick<EngineConfig, "savings">>, now: Date): string[] {
  const today = teamDay(now);
  const days: string[] = [];
  for (let t = Date.parse(`${savingsConfig(engine).since}T12:00:00Z`); ; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > today) break;
    days.push(d);
  }
  return days;
}
