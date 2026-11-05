import type { FetchedPage } from "./fetcher";

/** The signals research can spot on a company's own site. Enable the ones you care about in business.yaml `signals`. */
export const SIGNALS = ["hiring", "new_office_or_launch", "mentions_competitor"] as const;
export type SignalName = (typeof SIGNALS)[number];

export interface DetectedSignal {
  signal: SignalName;
  evidence: string;
  url: string;
}

export interface SignalOptions {
  /** Competitor product names (business.yaml `competitors`); a sentence naming one is the strongest opener. */
  competitors?: string[];
  /** Our own company name, so a page that mentions us alongside a competitor isn't counted. */
  ownName?: string;
  /** Only these signals are reported; empty or missing = all of them. */
  enabled?: string[];
}

const HIRING_RE = /\b(we'?re hiring|now hiring|join our team|open positions?|now accepting applications|we are looking for|we're looking for|apply (?:now|today)|job openings?|career opportunit)/i;
const LAUNCH_RE = /\b(new office|now open|grand opening|opened (?:our|a) (?:new )?(?:office|location|store|shop)|newly opened|proud to announce (?:the )?opening|launched (?:our|the) (?:company|business|company|practice)|opening (?:of )?(?:our|a) (?:second|new) (?:office|location))\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);
}

/**
 * Rule-based signal detection. Every signal carries the exact sentence that
 * triggered it, so it is grounded by construction and becomes a fact.
 */
export function detectSignals(pages: FetchedPage[], now: Date, opts: SignalOptions = {}): DetectedSignal[] {
  const names = (opts.competitors ?? []).map((c) => c.trim()).filter(Boolean);
  const competitorRe = names.length ? new RegExp(`\\b(${names.map((c) => escapeRe(c).replace(/\s+/g, "\\s+")).join("|")})\\b`) : null;
  const ownRe = opts.ownName?.trim() ? new RegExp(escapeRe(opts.ownName.trim()), "i") : null;
  const enabled = new Set(opts.enabled?.length ? opts.enabled : SIGNALS);
  const out: DetectedSignal[] = [];
  const seen = new Set<string>();
  const add = (s: DetectedSignal) => {
    if (seen.has(s.signal) || !enabled.has(s.signal)) return;
    seen.add(s.signal);
    out.push({ ...s, evidence: s.evidence.slice(0, 280) });
  };
  for (const page of pages) {
    const isCareers = /career|jobs|join|employment|hiring/i.test(page.url);
    for (const s of sentences(page.text)) {
      if (HIRING_RE.test(s) || (isCareers && /\b(position|role|opening|full[- ]time|part[- ]time)\b/i.test(s))) add({ signal: "hiring", evidence: s, url: page.url });
      if (LAUNCH_RE.test(s)) add({ signal: "new_office_or_launch", evidence: s, url: page.url });
      const founded = s.match(/\b(?:founded|established|opened)\s+(?:in\s+)?(20\d{2})\b/i);
      if (founded && Number(founded[1]) >= now.getUTCFullYear() - 1) add({ signal: "new_office_or_launch", evidence: s, url: page.url });
      if (competitorRe?.test(s) && !ownRe?.test(s)) add({ signal: "mentions_competitor", evidence: s, url: page.url });
    }
  }
  return out;
}
