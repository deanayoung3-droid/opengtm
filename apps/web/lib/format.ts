import { REPLY_LABEL_NAMES, TEAM_TZ } from "@opengtm/core";

export const usd = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? "-" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(digits)}`);
export const pct = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "-" : `${(n * 100).toFixed(1)}%`);

export function when(d: Date | string | null | undefined): string {
  if (!d) return "-";
  const date = new Date(d);
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TEAM_TZ });
}

export function ago(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "-";
  const s = Math.round((now.getTime() - new Date(d).getTime()) / 1000);
  if (s < 0) return when(d); // clock skew or future-dated rows
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const name = (c: { firstName: string | null; lastName: string | null; email: string }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email;

/** What the engine already did with a reply, in plain words. */
export function engineDid(action: string | null | undefined): string | null {
  if (!action || action === "none") return null;
  if (action.startsWith("email_changed:")) return `They moved: added ${action.slice(14)} as a new lead (it goes through checks and your approval before anything is sent).`;
  if (action.startsWith("paused_until:")) return `Paused their emails until ${new Date(action.slice(13)).toLocaleDateString("en-US", { month: "short", day: "numeric" })} (out of office).`;
  const map: Record<string, string> = {
    hot_lead_drafted: "Drafted a reply with your booking link.",
    objection_drafted: "Drafted a reply that answers the objection.",
    snoozed: "Stopped emailing them and scheduled a check-in in a couple of months.",
    referral_added: "Added the person they pointed to as a new lead.",
    referral_exists: "The person they pointed to is already a lead.",
    referral_suppressed: "The person they pointed to has opted out, so they were not added.",
    no_referral_found: "They pointed elsewhere but no email address was found.",
    suppressed: "Removed them from all future emails.",
    suppressed_firm: "Removed everyone at the company from all future emails.",
    suppressed_bounce: "Marked the address as bounced and removed it.",
    needs_human: "Couldn't tell what they meant, so left it for you.",
    recipient_gone: "They no longer work there, so this address was dropped.",
  };
  return map[action] ?? null;
}

/** Names for reply states (shared with the team alert emails). */
export const STATUS_NAME = REPLY_LABEL_NAMES;

const DAY_NAME: Record<string, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** The sending days in words: "Monday to Friday and Sunday". */
export function sendDaysText(t: { send_days?: string[]; send_weekends: boolean }): string {
  const days = t.send_days?.length ? t.send_days : t.send_weekends ? WEEK : WEEK.slice(0, 5);
  const set = new Set(days);
  if (set.size === 7) return "every day";
  const weekdays = WEEK.slice(0, 5).every((d) => set.has(d));
  const extra = WEEK.filter((d) => set.has(d) && !(weekdays && WEEK.indexOf(d) < 5)).map((d) => DAY_NAME[d]!);
  const list = (a: string[]) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a.at(-1)}` : (a[0] ?? ""));
  return weekdays ? (extra.length ? `Monday to Friday and ${list(extra)}` : "Monday to Friday") : list(extra);
}

/** "09:00" -> "9:00 AM"; `shift` moves it by whole hours (e.g. -3 for Eastern recipients seen from Pacific team time). */
export function clock(hhmm: string, shift = 0): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const hh = (((h + shift) % 24) + 24) % 24;
  return `${hh % 12 || 12}:${String(m).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

/** Date and time on the team's clock, with the zone: "Mon, Oct 26, 6:00 AM PT". */
export function whenPT(d: Date | string | null | undefined): string {
  if (!d) return "-";
  return `${new Date(d).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TEAM_TZ })} PT`;
}
