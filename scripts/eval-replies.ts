/**
 * Acceptance check for reply classification on the configured models (rules first, then the LLM):
 *   pnpm eval:replies                       # the bundled samples in tests/fixtures/replies.json
 *   pnpm eval:replies path/to/replies.json  # your own labeled replies (items: { label, subject, body, from? })
 * Reports accuracy per label (target >= 90%). Each reply is read as an answer to a usual first email
 * (a "just reply yes" ask), as it would be in production. If a label misses, raise
 * replies.classify_min_confidence so more replies get the second opinion, or improve that label's
 * definition in prompts/reply_classify.md. Keep real replies out of git: they are other people's words.
 */
import { readFileSync } from "node:fs";
import { Alerter, ConsoleSink, createLlm, createLogger, decisionProvidersFromEnv, findRepoRoot, loadConfig, providersFromEnv, REPLY_LABELS, systemClock } from "@opengtm/core";
import { createTestDb } from "@opengtm/core/testing";
import { classifyReply } from "@opengtm/replies";

const root = findRepoRoot();
const file = process.argv[2] ?? `${root}/tests/fixtures/replies.json`;
type Sample = { label: string; subject: string; body: string; from?: string; note?: string; headers?: Record<string, string> };
const samples = JSON.parse(readFileSync(file, "utf8")) as Sample[];
const config = loadConfig();
const log = createLogger("eval", "warn");
const { db, close } = await createTestDb();
const ctx = {
  db,
  config,
  clock: systemClock,
  log,
  env: process.env,
  random: Math.random,
  alerts: new Alerter(db, [new ConsoleSink(log)], systemClock, log),
  llm: createLlm({ db, config, providers: providersFromEnv(config.llm, process.env), decisionProviders: decisionProvidersFromEnv(config.llm, process.env), clock: systemClock, log }),
};

const co = config.business.company;
const OUR_EMAIL = `Hi Ana,\n\nI came across Rivera Heating & Air and saw you handle heating and air conditioning in Austin.\n\nI'm Alex at ${co.name}. ${co.one_liner}.\n\nWant a quick look? Just reply "${config.business.outreach.cta_reply}" and I'll send it over.`;
const perLabel = new Map<string, { ok: number; n: number; misses: string[] }>();
let ok = 0;
for (const s of samples) {
  const auto = s.headers?.["auto-submitted"] ? "headers:auto_reply" : null;
  const res = await classifyReply(ctx, { subject: s.subject, body: s.body, classifiedBy: auto, fromEmail: s.from ?? "prospect@example.com", ourLastEmail: OUR_EMAIL, conversation: `Us (Alex), 2026-10-21:\n${OUR_EMAIL}`, who: "Ana Rivera, Owner at Rivera Heating & Air (hvac, TX)" });
  const got = res.label;
  const hit = got === s.label;
  if (hit) ok++;
  const row = perLabel.get(s.label) ?? { ok: 0, n: 0, misses: [] };
  row.n++;
  if (hit) row.ok++;
  else row.misses.push(`${got} [${res.label}] (${res.by}, ${res.confidence.toFixed(2)}): ${s.body.replace(/\s+/g, " ").slice(0, 80)}${s.note ? `  -- ${s.note}` : ""}`);
  perLabel.set(s.label, row);
}
const acc = ok / samples.length;
console.log(`\nOverall accuracy: ${(acc * 100).toFixed(1)}% (${ok}/${samples.length})  target >= 90%\n`);
for (const label of [...new Set([...REPLY_LABELS, ...perLabel.keys()])]) {
  const r = perLabel.get(label);
  if (!r) continue;
  console.log(`${label.padEnd(14)} ${r.ok}/${r.n}${r.misses.length ? `\n  ${r.misses.join("\n  ")}` : ""}`);
}
const weak = [...perLabel].filter(([, r]) => r.ok / r.n < 0.9).map(([l]) => l);
if (acc < 0.9 || weak.length) {
  console.log(`\nBelow target. Raise replies.classify_min_confidence so more replies get the LLM second opinion, or sharpen the definitions for: ${weak.join(", ")}.`);
  process.exitCode = 1;
}
await close();
