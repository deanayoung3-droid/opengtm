import { contentWords, loadPrompt, render, type Ctx } from "@opengtm/core";
import { z } from "zod";
import type { FetchedPage } from "./fetcher";

export const FACT_KINDS = ["about", "team", "services", "news", "careers", "other"] as const;

const MAX_FACTS = 12;
const MAX_AREAS = 10;

export const ExtractSchema = z.object({
  facts: z
    .array(
      z.object({
        text: z.string().describe("One atomic, verifiable statement about the company, copied closely from the page"),
        source_url: z.string().describe("The exact URL of the page the statement came from"),
        kind: z.enum(FACT_KINDS),
      }),
    )
    .describe(`At most ${MAX_FACTS}`),
  // No hard max: a model that lists a few extra used to fail the whole extraction (2026-11-04); extras are dropped below.
  focus_areas: z.array(z.string()).describe(`At most ${MAX_AREAS}`),
  team_size: z.number().int().nullable().describe("Number of people on the team if the site states or lists them, else null"),
});
export type Extracted = z.infer<typeof ExtractSchema>;

export interface ExtractedFact {
  text: string;
  sourceUrl: string;
  kind: (typeof FACT_KINDS)[number];
}

const PAGE_CHARS = 5000;
const TOTAL_CHARS = 22000;

export function pagesForPrompt(pages: FetchedPage[]): string {
  let budget = TOTAL_CHARS;
  const parts: string[] = [];
  for (const p of pages) {
    if (budget <= 0) break;
    const text = p.text.slice(0, Math.min(PAGE_CHARS, budget));
    budget -= text.length;
    parts.push(`<page url="${p.url}">\n${text}\n</page>`);
  }
  return parts.join("\n\n");
}

/**
 * A fact is kept only if its source URL is one we fetched and most of its
 * content words actually appear on that page. This catches hallucinated or
 * misattributed facts from smaller local models.
 */
export function groundFacts(facts: Extracted["facts"], pages: FetchedPage[]): ExtractedFact[] {
  const byUrl = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  const out: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    const text = f.text.replace(/\s+/g, " ").trim();
    if (text.length < 12 || text.length > 300) continue;
    const page = byUrl.get(normalizeUrl(f.source_url));
    if (!page) continue;
    const words = contentWords(text);
    if (words.length < 2) continue;
    const hay = page.text.toLowerCase();
    const hits = words.filter((w) => hay.includes(w)).length;
    if (hits / words.length < 0.7) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, sourceUrl: page.url, kind: f.kind });
  }
  return out;
}

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

export async function extractFacts(
  ctx: Ctx,
  companyId: string,
  companyName: string,
  pages: FetchedPage[],
): Promise<{ facts: ExtractedFact[]; focusAreas: string[]; teamSize: number | null; promptVersion: string }> {
  const prompt = loadPrompt("research_extract");
  const res = await ctx.llm.run(
    "research_extract",
    {
      system: prompt.system,
      prompt: render(prompt.user, { firm_name: companyName, pages: pagesForPrompt(pages) }),
      promptVersion: prompt.version,
    },
    ExtractSchema,
    { companyId, expectedOutputTokens: 1200 },
  );
  return {
    facts: groundFacts(res.data.facts.slice(0, MAX_FACTS), pages),
    focusAreas: res.data.focus_areas.map((p) => p.toLowerCase().trim()).filter(Boolean).slice(0, MAX_AREAS),
    teamSize: res.data.team_size,
    promptVersion: prompt.version,
  };
}
