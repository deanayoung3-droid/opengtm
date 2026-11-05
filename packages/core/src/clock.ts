export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A controllable clock for simulations and tests. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date | string): void {
    this.t = new Date(d).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** YYYY-MM-DD in UTC; used for per-day counters. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function startOfUtcDay(d: Date): Date {
  return new Date(`${utcDay(d)}T00:00:00.000Z`);
}

/**
 * The team's clock (TEAM_TIMEZONE, an IANA zone like "America/New_York"; Pacific by default): job schedules,
 * daily caps and counters, charts and every time shown in the dashboard use it. Emails still go out in each
 * recipient's own business hours.
 */
export const TEAM_TZ = process.env.TEAM_TIMEZONE?.trim() || "America/Los_Angeles";
/** Short name of the team time zone right now, e.g. "PT" or "EST". */
export const TEAM_TZ_LABEL = ((): string => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TEAM_TZ, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? TEAM_TZ;
  return name.replace(/^P[SD]T$/, "PT").replace(/^M[SD]T$/, "MT").replace(/^C[SD]T$/, "CT").replace(/^E[SD]T$/, "ET");
})();

const teamDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TEAM_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD on the team's calendar: daily caps, counters and charts roll over at the team's midnight. */
export function teamDay(d: Date): string {
  return teamDayFmt.format(d);
}

/** Midnight at the start of d's team day, in any time zone (DST-safe, to the quarter hour). */
export function startOfTeamDay(d: Date): Date {
  const target = teamDay(d);
  const [y, m, day] = target.split("-").map(Number) as [number, number, number];
  // Local midnight falls between 14:00 UTC the day before and 14:00 UTC that day; take the first quarter hour on the day.
  const from = Date.UTC(y, m - 1, day) - 14 * HOUR;
  for (let t = from; t <= from + 28 * HOUR; t += 15 * 60_000) if (teamDay(new Date(t)) === target) return new Date(t);
  return new Date(Date.UTC(y, m - 1, day));
}

/** The last `n` team days ending with today's, oldest first. */
export function lastTeamDays(n: number, now: Date): string[] {
  const out: string[] = [];
  let t = startOfTeamDay(now).getTime() + 12 * HOUR;
  for (let i = 0; i < n; i++, t -= DAY) out.unshift(teamDay(new Date(t)));
  return out;
}

/** Start of the current billing cycle for a plan that renews on `day` of each month (UTC; 1 = calendar month). */
export function billingCycleStart(now: Date, day: number): Date {
  const d = Number.isFinite(day) ? Math.min(Math.max(1, Math.round(day)), 28) : 1;
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d));
  return thisMonth.getTime() <= now.getTime() ? thisMonth : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, d));
}
