export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function domainOf(email: string): string {
  return normalizeEmail(email).split("@")[1] ?? "";
}

export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^@/, "").replace(/^https?:\/\//, "").replace(/^www\./, "");
  return d.split(/[/?#]/)[0] ?? "";
}

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "aol.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "comcast.net", "att.net", "verizon.net", "sbcglobal.net",
  "bellsouth.net", "cox.net", "charter.net", "earthlink.net", "gmx.com", "zoho.com", "fastmail.com",
]);

/** A public mailbox provider: a domain there is not a company, so it is never suppressed or matched as one. */
export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.has(normalizeDomain(domain));
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

const ROLE_LOCAL_PARTS = new Set([
  "info", "office", "contact", "admin", "hello", "intake", "reception", "frontdesk", "front.desk",
  "mail", "support", "team", "legal", "inquiries", "inquiry", "help", "billing",
  "accounts", "careers", "jobs", "hr", "marketing", "sales", "webmaster", "postmaster", "noreply", "no-reply",
]);

export function isRoleAddress(email: string): boolean {
  const local = normalizeEmail(email).split("@")[0] ?? "";
  return ROLE_LOCAL_PARTS.has(local);
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function isValidEmailSyntax(email: string): boolean {
  const e = normalizeEmail(email);
  if (e.length > 254 || !EMAIL_RE.test(e)) return false;
  const [local, domain] = e.split("@");
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return !!domain && /\.[a-z]{2,}$/.test(domain);
}

/** Lowercased content words (len>=4) used for fuzzy grounding checks. */
export function contentWords(text: string): string[] {
  const stop = new Set(["that", "this", "with", "from", "have", "their", "they", "your", "about", "which", "were", "been", "also", "into", "more", "than", "them", "will", "what", "when", "where", "there", "these", "those", "company", "companies"]);
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{3,}/gu) ?? []).filter((w) => !stop.has(w));
}

const ON_WROTE = /^\s*On\s.{5,300}?\swrote:\s*$/i;
const HISTORY_START = [
  /^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i,
  /^\s*_{10,}\s*$/, // Outlook separator line
  /^\s*Begin forwarded message:/i,
];

/**
 * Remove quoted history from an email reply (">" lines, "On ... wrote:" even when wrapped over
 * several lines, Outlook "From: / Sent:" headers, forwarded blocks) and keep only the new text.
 */
export function stripQuotedHistory(text: string): string {
  const flat = text.replace(/\r\n?/g, "\n");
  // Some clients flatten everything onto one line: "sure :) On Fri, Oct 23, 2026 at 6:29 AM X <x@y> wrote: > Hi"
  const inline = flat.search(/\sOn\s[^\n]{5,200}?\swrote:\s*(>|$)/);
  const lines = (inline > 0 && !flat.slice(0, inline).includes("\n") ? flat.slice(0, inline) : flat).split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*>/.test(line)) continue;
    const joined = [line, lines[i + 1] ?? "", lines[i + 2] ?? ""].map((l) => l.trim());
    if (ON_WROTE.test(line) || (/^\s*On\s/i.test(line) && (ON_WROTE.test(`${joined[0]} ${joined[1]}`) || ON_WROTE.test(joined.join(" "))))) break;
    if (HISTORY_START.some((re) => re.test(line))) break;
    if (/^\s*\*?From:\*?\s.+/i.test(line) && lines.slice(i + 1, i + 5).some((l) => /^\s*\*?(Sent|Date|To|Subject):/i.test(l))) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

const SIGN_OFF_CUT = [
  /^\s*--\s*$/, // standard signature delimiter
  /^\s*-{3,}\s*(notice|confidential)/i,
  /^\s*(sent from my (iphone|ipad|android|phone|mobile|samsung)|get outlook for (ios|android))/i,
  /^\s*\**\s*(notice of confidentiality|confidentiality notice|confidential(ity)? notice|privileged (and|&) confidential|this (e-?mail|message|communication)( and any attachments)? (is|are|may be|contains?) (confidential|privileged|intended))/i,
];

/** The words a prospect actually wrote: no quoted history, signature delimiter, legal notice, or image tags. */
export function newReplyText(text: string): string {
  const lines = stripQuotedHistory(text).split("\n");
  const cut = lines.findIndex((l) => SIGN_OFF_CUT.some((re) => re.test(l)));
  return (cut >= 0 ? lines.slice(0, cut) : lines)
    .join("\n")
    .replace(/\[image:[^\]]*\]/gi, "")
    .replace(/<https?:\/\/[^>\s]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CONTACT_LINE = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s().-]{7,}\d/i;
const SIGN_OFF = /^(thanks|thank you|many thanks|best|best regards|regards|kind regards|warm regards|sincerely|cheers|respectfully)[\s,.!]*$/i;

/**
 * The gist of a reply for a team alert: what they wrote, without the contact block under it (name,
 * title, offices, phone, links) or the sign-off. "Yes!\n\nRosa Delgado\nOwner ..." -> "Yes!"
 */
export function replyGist(body: string, name: { first?: string | null; last?: string | null } = {}, max = 600): string {
  const lines = newReplyText(body)
    .replace(/<(mailto|tel):[^>\s]+>/gi, "")
    .split("\n")
    .map((l) => l.trim());
  const who = [name.first, name.last].filter((n): n is string => !!n && n.length > 1).map((n) => n.toLowerCase());
  const startsWithName = (l: string) => who.some((n) => l.toLowerCase().startsWith(n)) && l.split(/\s+/).length <= 6;
  const out: string[] = [];
  for (const l of lines) {
    const said = out.some((o) => o);
    if (said && (CONTACT_LINE.test(l) || SIGN_OFF.test(l) || startsWithName(l))) break;
    if (!said && !l) continue;
    out.push(l);
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text;
}

/** Names for reply states. */
export const REPLY_LABEL_NAMES: Record<string, string> = {
  out_of_office: "Out of Office",
  email_changed: "Email Changed",
  recipient_gone: "Recipient Gone",
  objection: "Not Interested",
  not_now: "Not Now",
  unsubscribe: "Unsubscribed",
  hostile: "Hostile",
  referral: "Handed Off",
  wrong_person: "Wrong Person",
  bounce: "Bounced",
  interested: "Interested",
  question: "Question",
  other: "Needs a look",
};

/** RFC 4180-ish CSV rows (quoted fields, escaped quotes, CRLF); blank lines dropped, fields untrimmed. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}
