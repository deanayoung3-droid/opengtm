/**
 * Acceptance check for research on real company sites:
 *   pnpm eval:research sites.txt      # one company URL per line, 20+ recommended
 * Target: >= 80% of companies yield at least 2 grounded facts whose source URLs load.
 * Uses the configured research_extract route and respects robots.txt.
 */
import { readFileSync } from "node:fs";
import { Alerter, ConsoleSink, createLlm, createLogger, decisionProvidersFromEnv, loadConfig, providersFromEnv, systemClock } from "@opengtm/core";
import { createTestDb } from "@opengtm/core/testing";
import { detectSignals, extractFacts, extractLinks, pickResearchPages, PoliteFetcher } from "@opengtm/research";

const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm eval:research <file with one company URL per line>");
  process.exit(1);
}
const urls = readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
const config = loadConfig();
const log = createLogger("eval", "warn");
const { db, close } = await createTestDb();
const ctx = { db, config, log, clock: systemClock, env: process.env, random: Math.random, alerts: new Alerter(db, [new ConsoleSink(log)], systemClock, log), llm: createLlm({ db, config, providers: providersFromEnv(config.llm, process.env), decisionProviders: decisionProvidersFromEnv(config.llm, process.env), clock: systemClock, log }) };
const fetcher = new PoliteFetcher({ userAgent: config.engine.research.user_agent, delayMs: config.engine.research.request_delay_ms });

let pass = 0;
for (const url of urls) {
  const home = await fetcher.fetch(url);
  if (!home) {
    console.log(`FAIL  ${url}: homepage unavailable or disallowed by robots.txt`);
    continue;
  }
  const pages = [home];
  for (const u of pickResearchPages(extractLinks(home.html, home.url), config.engine.research.max_pages - 1)) {
    const p = await fetcher.fetch(u);
    if (p) pages.push(p);
  }
  try {
    const ex = await extractFacts(ctx, crypto.randomUUID(), new URL(url).host, pages);
    const signals = detectSignals(pages, new Date(), { competitors: ctx.config.business.competitors, ownName: ctx.config.business.company.name });
    const live = await Promise.all(ex.facts.map(async (f) => (await fetch(f.sourceUrl, { method: "GET" }).catch(() => null))?.ok ?? false));
    const good = ex.facts.filter((_, i) => live[i]).length;
    const ok = good >= 2;
    if (ok) pass++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${url}: ${good}/${ex.facts.length} grounded facts with live sources, signals: ${signals.map((s) => s.signal).join(", ") || "none"}`);
    for (const f of ex.facts.slice(0, 4)) console.log(`        - ${f.text}  <${f.sourceUrl}>`);
  } catch (err) {
    console.log(`FAIL  ${url}: ${(err as Error).message}`);
  }
}
const rate = urls.length ? pass / urls.length : 0;
console.log(`\n${pass}/${urls.length} companies (${(rate * 100).toFixed(0)}%) yielded >= 2 facts. Target 80%.`);
await close();
process.exitCode = rate >= 0.8 ? 0 : 1;
