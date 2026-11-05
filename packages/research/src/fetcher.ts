import * as cheerio from "cheerio";
import robotsParser from "robots-parser";

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  text: string;
  title: string;
  fetchedAt: Date;
}

export interface PageFetcher {
  /** Returns null when the page is disallowed, missing, or not HTML. */
  fetch(url: string): Promise<FetchedPage | null>;
}

type Robots = ReturnType<typeof robotsParser> | "allow_all" | "deny_all";

/**
 * Polite HTTP fetcher: honors robots.txt, identifies itself, rate-limits per host,
 * caps response size, and only returns HTML.
 */
export class PoliteFetcher implements PageFetcher {
  private robots = new Map<string, Robots>();
  private lastHit = new Map<string, number>();

  constructor(
    private opts: {
      userAgent: string;
      delayMs: number;
      timeoutMs?: number;
      maxBytes?: number;
      fetchImpl?: typeof fetch;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  private get f() {
    return this.opts.fetchImpl ?? fetch;
  }

  private async robotsFor(origin: string): Promise<Robots> {
    const cached = this.robots.get(origin);
    if (cached) return cached;
    let r: Robots;
    try {
      const res = await this.f(`${origin}/robots.txt`, {
        headers: { "user-agent": this.opts.userAgent },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (res.status >= 500) r = "deny_all";
      else if (!res.ok) r = "allow_all";
      else r = robotsParser(`${origin}/robots.txt`, await res.text());
    } catch {
      r = "deny_all"; // RFC 9309: unreachable robots.txt means assume full disallow
    }
    this.robots.set(origin, r);
    return r;
  }

  async allowed(url: string): Promise<boolean> {
    const u = new URL(url);
    const r = await this.robotsFor(u.origin);
    if (r === "allow_all") return true;
    if (r === "deny_all") return false;
    return r.isAllowed(url, this.opts.userAgent) !== false;
  }

  private async throttle(host: string) {
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const last = this.lastHit.get(host);
    if (last !== undefined) {
      const wait = last + this.opts.delayMs - now();
      if (wait > 0) await sleep(wait);
    }
    this.lastHit.set(host, now());
  }

  async fetch(url: string): Promise<FetchedPage | null> {
    if (!(await this.allowed(url))) return null;
    const host = new URL(url).host;
    await this.throttle(host);
    let res: Response;
    try {
      res = await this.f(url, {
        headers: { "user-agent": this.opts.userAgent, accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return null;
    const html = (await res.text()).slice(0, this.opts.maxBytes ?? 1_500_000);
    const finalUrl = res.url || url;
    return { url: finalUrl, status: res.status, html, ...htmlToText(html), fetchedAt: new Date() };
  }
}

/** Canned pages for tests and offline runs. */
export class StaticFetcher implements PageFetcher {
  constructor(private pages: Record<string, string>) {}
  async fetch(url: string): Promise<FetchedPage | null> {
    const html = this.pages[url] ?? this.pages[url.replace(/\/$/, "")] ?? this.pages[`${url}/`];
    if (html === undefined) return null;
    return { url, status: 200, html, ...htmlToText(html), fetchedAt: new Date() };
  }
}

export function htmlToText(html: string): { text: string; title: string } {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  $("script, style, noscript, svg, iframe, nav, form, [aria-hidden=true]").remove();
  const blocks: string[] = [];
  $("h1, h2, h3, h4, p, li, td, blockquote, address, footer, dd, dt").each((_, el) => {
    const $el = $(el);
    if ($el.find("p, li").length > 0 && !$el.is("li")) return; // avoid duplicating container text
    const t = $el.text().replace(/\s+/g, " ").trim();
    if (t.length > 1) blocks.push(t);
  });
  const text = (blocks.length ? blocks.join("\n") : $("body").text().replace(/\s+/g, " ")).trim();
  return { text, title };
}

export interface PageLink {
  url: string;
  text: string;
}

export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const out: PageLink[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) return;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      return;
    }
    if (u.host.replace(/^www\./, "") !== base.host.replace(/^www\./, "")) return;
    u.hash = "";
    const key = u.toString();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: key, text: $(el).text().replace(/\s+/g, " ").trim() });
  });
  return out;
}

export function extractMailtos(html: string): { email: string; context: string }[] {
  const $ = cheerio.load(html);
  const out: { email: string; context: string }[] = [];
  $("a[href^='mailto:']").each((_, el) => {
    const email = decodeURIComponent(($(el).attr("href") ?? "").slice(7).split("?")[0] ?? "").trim();
    const context = $(el).parent().text().replace(/\s+/g, " ").trim().slice(0, 200);
    if (email) out.push({ email, context });
  });
  return out;
}

const PAGE_PRIORITY: [RegExp, number][] = [
  [/about|our-company|who-we-are|company-overview/i, 10],
  [/team|staff|people|our-people|leadership|professionals/i, 9],
  [/services|solutions|products|what-we-do|industries/i, 8],
  [/career|jobs|join|employment|hiring|opportunit/i, 7],
  [/news|press|blog|announce|events/i, 5],
  [/contact|location|office/i, 4],
];

/** Choose the most informative internal pages to read. */
export function pickResearchPages(links: PageLink[], max: number): string[] {
  const scored = links
    .map((l) => {
      const hay = `${new URL(l.url).pathname} ${l.text}`;
      const score = Math.max(0, ...PAGE_PRIORITY.filter(([re]) => re.test(hay)).map(([, s]) => s));
      return { url: l.url, score, depth: new URL(l.url).pathname.split("/").filter(Boolean).length };
    })
    .filter((l) => l.score > 0 && !/\.(pdf|jpg|png|docx?)$/i.test(l.url))
    .sort((a, b) => b.score - a.score || a.depth - b.depth);
  const picked: string[] = [];
  const usedScores = new Map<number, number>();
  for (const l of scored) {
    if ((usedScores.get(l.score) ?? 0) >= 2) continue; // at most 2 pages per category
    usedScores.set(l.score, (usedScores.get(l.score) ?? 0) + 1);
    picked.push(l.url);
    if (picked.length >= max) break;
  }
  return picked;
}
