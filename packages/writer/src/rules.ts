import { wordCount } from "@opengtm/core";

export interface DraftStep {
  step: number;
  body: string;
  fact_ids: string[];
  proof_point_ids: string[];
}

export interface Issue {
  code: string;
  message: string;
}

export interface RuleContext {
  /** fact id -> text, only facts stored for this company. */
  facts: Map<string, string>;
  /** proof point id -> text, only from business.yaml. */
  proofPoints: Map<string, string>;
  bannedClaims: string[];
  minWords: number;
  /** Lower bound for follow-ups (step 2 on); minWords when not set. */
  followupMinWords?: number;
  maxWords: number;
  bookingLink: string;
  /** Our own website's host (company.site), which the plain step 2 follow-up must not mention. */
  siteHost?: string | null;
}

const SPAM_PATTERNS: RegExp[] = [
  /\b(100% (free|guaranteed)|risk[- ]free|act now|limited time|click here|buy now|order now|call now|apply now)\b/i,
  /\b(winner|cash bonus|no obligation|special promotion|double your|lowest price|best price|once in a lifetime|exclusive deal|incredible deal)\b/i,
  /\b(free (trial|gift|offer|consultation|of charge)|for free|absolutely free)\b/i,
  /\$\$+|!!+/,
];

const FAKE_FAMILIARITY = /\b(as (we|i) (discussed|mentioned|promised)|following up on our (call|conversation|chat|meeting)|great (chatting|talking|speaking|meeting) with you|per our (conversation|call|chat)|as promised|you (requested|asked for)|thanks for (your interest|reaching out|downloading|signing up)|good to (see|reconnect)|it was (great|nice) (to )?(meet|talk|connect)|we spoke)\b/i;
const FAKE_URGENCY = /\b(last chance|only \d+ (spots|seats|slots) left|expires? (today|tomorrow|soon)|act (now|fast)|before it'?s too late|urgent|time[- ]sensitive|ends (today|tonight|friday))\b/i;
const HTML_OR_MARKDOWN = /<[a-z][^>]*>|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|^#{1,6}\s|^\s*[-*]\s/im;
const PLACEHOLDER = /\{\{|\}\}|\[(first ?name|name|company|company( name)?|your name)\]|<(first_?name|company)>/i;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s)>\]\u2013\u2014"'“”]+[^\s)>\]\u2013\u2014"'“”.,;:!?]/gi; // ends before dashes and trailing punctuation
const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?%?/g;

function bannedMatch(text: string, claim: string): boolean {
  const re = claim.match(/^\/(.+)\/([a-z]*)$/);
  if (re) return new RegExp(re[1]!, re[2]!.includes("i") ? re[2] : `${re[2]}i`).test(text);
  return text.toLowerCase().includes(claim.toLowerCase());
}

/** Checks applied to the subject line (step 1 only; follow-ups reuse it with a real "Re:"). */
/**
 * House formatting for every email body, whatever the model returned: the greeting on its own line, a
 * blank line between paragraphs, and plain punctuation (em dashes read as machine-written).
 */
export function tidyBody(body: string): string {
  let t = body.replace(/\r\n?/g, "\n").trim();
  t = t.replace(/(?<!\d)[ \t]*[\u2014\u2013][ \t]*(?!\d)/g, ", ").replace(/,\s*([,.;:!?])/g, "$1");
  t = t.replace(/^((?:hi|hello|hey|dear|hola|bonjour|ol[aá])\b[^\n,]{0,60},)[ \t]*\n*/i, "$1\n\n");
  return t
    .split(/\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function checkSubject(subject: string, bannedClaims: string[]): Issue[] {
  const issues: Issue[] = [];
  const s = subject.trim();
  if (!s) issues.push({ code: "subject_empty", message: "Subject is empty" });
  if (/^(re|fw|fwd)\s*:/i.test(s)) issues.push({ code: "fake_reply_subject", message: "First email subject must not pretend to be a reply or forward" });
  if (s.length > 60) issues.push({ code: "subject_length", message: `Subject is ${s.length} chars (max 60)` });
  if (/[A-Z]{5,}/.test(s)) issues.push({ code: "subject_caps", message: "Subject contains shouting caps" });
  if (/[!$]/.test(s)) issues.push({ code: "subject_spammy", message: "Subject contains ! or $" });
  for (const b of bannedClaims) if (bannedMatch(s, b)) issues.push({ code: "banned_claim", message: `Subject contains banned claim "${b}"` });
  return issues;
}

/**
 * Deterministic critic. Every check here is a hard rule: a failure means the
 * draft cannot be sent as written.
 */
export function checkStep(d: DraftStep, ctx: RuleContext): Issue[] {
  const issues: Issue[] = [];
  const body = d.body.trim();

  for (const id of d.fact_ids) {
    if (!ctx.facts.has(id)) issues.push({ code: "unknown_fact", message: `Cites fact ${id}, which is not in the fact store for this company` });
  }
  for (const id of d.proof_point_ids) {
    if (!ctx.proofPoints.has(id)) issues.push({ code: "unknown_proof_point", message: `Cites proof point ${id}, which is not in business.yaml` });
  }

  // Any number in the email must come from a cited fact or proof point.
  const cited = [
    ...d.fact_ids.map((id) => ctx.facts.get(id) ?? ""),
    ...d.proof_point_ids.map((id) => ctx.proofPoints.get(id) ?? ""),
  ].join(" ");
  for (const n of body.match(NUMBER_RE) ?? []) {
    if (!cited.includes(n.replace(/,/g, "")) && !cited.includes(n)) {
      issues.push({ code: "unsupported_number", message: `"${n}" does not appear in any cited fact or proof point` });
    }
  }

  for (const b of ctx.bannedClaims) {
    if (bannedMatch(body, b)) issues.push({ code: "banned_claim", message: `Contains banned claim "${b}"` });
  }
  for (const re of SPAM_PATTERNS) {
    const m = body.match(re);
    if (m) issues.push({ code: "spam_words", message: `Spam trigger: "${m[0]}"` });
  }
  if (FAKE_FAMILIARITY.test(body)) issues.push({ code: "fake_familiarity", message: `Implies a prior relationship: "${body.match(FAKE_FAMILIARITY)![0]}"` });
  if (FAKE_URGENCY.test(body)) issues.push({ code: "fake_urgency", message: `Manufactured urgency: "${body.match(FAKE_URGENCY)![0]}"` });
  if (HTML_OR_MARKDOWN.test(body)) issues.push({ code: "not_plain_text", message: "Contains HTML, markdown, or bullet formatting" });
  if (PLACEHOLDER.test(body)) issues.push({ code: "placeholder", message: "Contains an unfilled placeholder" });

  const words = wordCount(body);
  const min = d.step > 1 ? (ctx.followupMinWords ?? ctx.minWords) : ctx.minWords;
  if (words < min || words > ctx.maxWords) {
    issues.push({ code: "word_count", message: `${words} words (allowed ${min}-${ctx.maxWords})` });
  }

  const questions = (body.match(/\?/g) ?? []).length;
  if (questions !== 1) issues.push({ code: "question_cta", message: `Needs exactly one question as the call to action (found ${questions})` });

  const urls = body.match(URL_RE) ?? [];
  if (d.step === 1 && urls.length) issues.push({ code: "link_in_step1", message: "Step 1 must contain no links" });
  // The first follow-up only goes to people who never replied: a plain nudge. The demo and booking link go to people who reply.
  if (d.step === 2 && urls.length) issues.push({ code: "link_in_step2", message: "Step 2 must contain no links (the demo and booking link go only to people who reply)" });
  if (d.step === 2 && (/\bdemo\b|\bbook (a|one|a time)\b|\bour founders\b/i.test(body) || (ctx.siteHost && body.toLowerCase().includes(ctx.siteHost)))) {
    issues.push({ code: "demo_in_step2", message: "Step 2 is a plain follow-up: no website, demo, booking or call (those go only to people who reply)" });
  }
  const bookingHost = ctx.bookingLink ? safeHost(ctx.bookingLink) : null;
  for (const u of urls) {
    if (d.step > 1 && (!bookingHost || safeHost(u.startsWith("www.") ? `https://${u}` : u) !== bookingHost)) {
      issues.push({ code: "link_not_allowed", message: `Only the booking link is allowed (found ${u})` });
    }
  }
  return issues;
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}
