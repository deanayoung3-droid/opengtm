import { newReplyText, type ReplyLabel } from "@opengtm/core";

export interface RuleResult {
  label: ReplyLabel;
  confidence: number;
  oooUntil: Date | null;
  removeWholeCompany: boolean;
  /** email_changed: the address they asked us to use instead. */
  newEmail?: string | null;
  summary?: string;
  hot?: boolean;
  replyNeeded?: boolean;
}

const OOO_SUBJECT = /(out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|away from (the |my )?(office|desk)|on (vacation|leave|holiday))/i;
const UNSUB_ONLY = /^(please )?(stop|unsubscribe( me)?|remove( me)?|take me off|opt[- ]?out|do not (contact|email) me( again)?|no thanks?,? (please )?remove( me)?)( (from|off) (your|this|the) (mailing |email )?list)?[\s.!]*$/i;
const WHOLE_FIRM = /\b(everyone|anyone|all of us|our (whole |entire )?company|this company|our office|anybody (here|at))\b/i;

// "I have joined X, my new address is ...", "no longer with the company", "please update your records".
const MOVED = /\b(no longer (with|at|employed|works? (at|for|with))|(has|have) (left|departed)( the company)?|left the company|(i|he|she|they) (have|has) (joined|moved to)|have joined|new (e-?mail )?address is|my new e-?mail|please update your (records|contact)|is no longer (with|at|employed|available)|contact (information|info|details) (has|have) changed|e-?mail (address )?has changed|(old|former|current) e-?mail address)\b/i;
// The mailbox itself is dead or its owner retired: "this email is no longer in use", "has retired from the practice of law".
const DEAD = /\b(no longer (in use|in service|valid|exists?|available|operational)|no longer (being )?(checked|checking|monitored|active|accepting (e-?mail|messages|mail))|(is )?an inactive (e-?mail|address|account|mailbox)|will (not|no longer) be (monitored|checked|read)|(has|have) retired|retired from (the )?(practice|company|law))\b/i;
// Only trusted in auto-replies (a person might write "our old account was closed"): "this account has been deactivated", "not monitored".
const DEAD_AUTO = /\b((e-?mail( address)?|address|mailbox|account|inbox)[^.\n]{0,40}? (is|was|has been) (inactive|deactivated|disabled|closed|deleted|discontinued|not (active|monitored|in use|checked))|(is|are) not (being )?monitored|unmonitored (e-?mail|mailbox|inbox|address))\b/i;
// Only trusted in auto-replies; a person writing "reach me at ..." is usually just answering.
const MOVED_AUTO = /\b(reach me at|direct (your |all |future )?e-?mails? to)\b/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Our first email asks them to just reply "yes", so a short yes is a hot lead.
const ASKED_FOR_YES = /reply\s+(with\s+)?["“'‘]?ye+s+\b/i; // "yes", "yesss", ...
const AFFIRMATIVE = /^(ye+s+|ye+s+ please|ye+s+,? please|yeah|yep|yup|sure|sure thing|sounds good|send it|send it over|please send|please do|go ahead|i'?m interested|interested|absolutely|definitely|of course|why not|let'?s see it|show me|y)[\s.!,:;)(\-]*(thanks?( you)?|please)?[\s.!,:;)(\-]*$/i;
const ONLY_EMOJI_YES = /^[\s👍👌✅🙂😀😊🙌]+$/u;
// A bare "no thanks": no reason to answer, and no reason to email them again.
const HARD_NO = /^(no|nope|no,? thanks?( you)?|thanks?,? but no( thanks?)?|not interested|(i am|i'?m|we are|we'?re) not interested|not for us|we'?ll pass|pass|no need|we'?re all set|we are all set|we'?re good|all set)( at (this|the moment|this time))?( right now| for now)?[\s.!,]*(thanks?( you)?|but thanks?|thank you though)?[\s.!,]*$/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Find a return date in an out-of-office message. Dates without a year resolve to the next occurrence. */
export function parseReturnDate(text: string, now: Date): Date | null {
  const t = text.replace(/\s+/g, " ");
  const anchor = /(until|through|returning|return(ing)? on|back (in the office )?on|back on|back in the office|will be back|out of (the )?office until)\s*(on\s*)?/i;
  const idx = t.search(anchor);
  const window = idx >= 0 ? t.slice(idx, idx + 80) : t.slice(0, 200);
  const named = window.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  const numeric = window.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  if (named) {
    month = MONTHS.indexOf(named[1]!.slice(0, 3).toLowerCase());
    day = Number(named[2]);
    year = named[3] ? Number(named[3]) : null;
  } else if (numeric) {
    month = Number(numeric[1]) - 1;
    day = Number(numeric[2]);
    year = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : null;
  }
  if (month === null || month < 0 || month > 11 || !day || day > 31) return null;
  let y = year ?? now.getUTCFullYear();
  let d = new Date(Date.UTC(y, month, day, 14));
  if (!year && d.getTime() < now.getTime() - 86_400_000) d = new Date(Date.UTC(++y, month, day, 14));
  // Ignore implausible dates (more than ~6 months out).
  if (d.getTime() - now.getTime() > 186 * 86_400_000) return null;
  return d;
}

/** Cheap, certain cases decided without a model. `ourLastEmail` lets a bare "yes" count when we asked for one. */
export function preClassify(r: { subject: string; body: string; classifiedBy: string | null; fromEmail?: string; ourLastEmail?: string }, now: Date): RuleResult | null {
  // Moved, left the company, or a dead mailbox (usually sent as an auto-reply, so checked before out-of-office).
  const fresh = newReplyText(r.body);
  const auto = r.classifiedBy === "headers:auto_reply" || OOO_SUBJECT.test(r.subject);
  // Some servers wrap the notice in a "From: ... Subject: ..." block that reads like quoted history.
  const notice = fresh.trim() ? fresh : r.body;
  if (MOVED.test(notice) || DEAD.test(notice) || (auto && (MOVED_AUTO.test(notice) || DEAD_AUTO.test(notice)))) {
    const from = (r.fromEmail ?? "").toLowerCase();
    const newEmail = (notice.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()).find((e) => e !== from) ?? null;
    return newEmail
      ? { label: "email_changed", confidence: 0.95, oooUntil: null, removeWholeCompany: false, newEmail }
      : { label: "recipient_gone", confidence: 0.9, oooUntil: null, removeWholeCompany: false };
  }
  if (auto) {
    return { label: "out_of_office", confidence: 0.99, oooUntil: parseReturnDate(`${r.subject} ${r.body}`, now), removeWholeCompany: false };
  }
  const firstLine = fresh.split(/\r?\n/)[0]?.trim() ?? "";
  const whole = fresh.trim();
  // Mail apps' own Unsubscribe button (our List-Unsubscribe mailto) sends subject "unsubscribe" with an empty body.
  const mailtoUnsub = /^\s*unsubscribe\s*$/i.test(r.subject) && (whole === "" || UNSUB_ONLY.test(firstLine));
  if (mailtoUnsub || UNSUB_ONLY.test(firstLine) || UNSUB_ONLY.test(whole)) {
    return { label: "unsubscribe", confidence: 0.99, oooUntil: null, removeWholeCompany: WHOLE_FIRM.test(whole) };
  }
  const oneLine = whole.replace(/\s+/g, " ");
  if (r.ourLastEmail && ASKED_FOR_YES.test(r.ourLastEmail) && oneLine.split(" ").length <= 8 && (AFFIRMATIVE.test(oneLine) || ONLY_EMOJI_YES.test(oneLine))) {
    return { label: "interested", confidence: 0.97, oooUntil: null, removeWholeCompany: false, hot: true, replyNeeded: true, summary: "Said yes to the free preview" };
  }
  if (HARD_NO.test(oneLine)) {
    return { label: "objection", confidence: 0.95, oooUntil: null, removeWholeCompany: false, hot: false, replyNeeded: false, summary: "Not interested (no reason given)" };
  }
  return null;
}
