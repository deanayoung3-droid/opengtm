import { TEAM_TZ } from "./clock";

// US state -> primary IANA timezone. States split across zones use the zone
// covering most of the population; sends stay inside a conservative window
// so a one-hour miss still lands in business hours.
const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR",
};

export function normalizeState(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  const up = t.toUpperCase();
  if (STATE_TZ[up]) return up;
  return STATE_NAMES[t.toLowerCase()] ?? null;
}

/** Unknown state -> Central time, the middle of the continental US. */
export function timezoneForState(state: string | null | undefined): string {
  const code = normalizeState(state);
  return (code && STATE_TZ[code]) || "America/Chicago";
}

export interface LocalParts {
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since local midnight
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function localParts(d: Date, tz: string): LocalParts {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { weekday: days.indexOf(parts.weekday ?? "Mon"), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Window {
  business_start: string;
  business_end: string;
  send_weekends: boolean;
  /** Days to send on (recipient's local day). When set it wins over send_weekends. */
  send_days?: Weekday[];
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function isWithinWindow(d: Date, tz: string, w: Window): boolean {
  const { weekday, minutes } = localParts(d, tz);
  if (w.send_days?.length) {
    if (!w.send_days.includes(WEEKDAYS[weekday]!)) return false;
  } else if (!w.send_weekends && (weekday === 0 || weekday === 6)) return false;
  return minutes >= toMinutes(w.business_start) && minutes < toMinutes(w.business_end);
}

/** Earliest instant >= d that falls inside the recipient's sending window (15-minute resolution). */
export function nextWindowStart(d: Date, tz: string, w: Window): Date {
  let t = new Date(d);
  for (let i = 0; i < 4 * 24 * 9; i++) {
    if (isWithinWindow(t, tz, w)) return t;
    t = new Date(Math.floor(t.getTime() / 900_000) * 900_000 + 900_000);
  }
  return t;
}



/**
 * Next time a daily or weekly cron ("M H * * D", D like 1-5 or 0,1) fires in `tz`. Null for
 * patterns this doesn't cover (every-N-minutes jobs), which callers describe in words instead.
 */
export function nextCronRun(cron: string, from: Date, tz = TEAM_TZ): Date | null {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!m || !h || !/^\d+$/.test(m) || !/^\d+$/.test(h) || dom !== "*" || mon !== "*") return null;
  const days = new Set<number>();
  for (const part of (dow ?? "*").split(",")) {
    if (part === "*") [0, 1, 2, 3, 4, 5, 6].forEach((d) => days.add(d));
    else if (/^\d-\d$/.test(part)) for (let d = Number(part[0]); d <= Number(part[2]); d++) days.add(d % 7);
    else if (/^\d$/.test(part)) days.add(Number(part) % 7);
    else return null;
  }
  const target = Number(h) * 60 + Number(m);
  // 15-minute steps cover every schedule we use (all on the hour or quarter hour).
  let t = Math.floor(from.getTime() / 900_000) * 900_000 + 900_000;
  for (let i = 0; i < 4 * 24 * 8; i++, t += 900_000) {
    const p = localParts(new Date(t), tz);
    if (p.minutes === target && days.has(p.weekday)) return new Date(t);
  }
  return null;
}
