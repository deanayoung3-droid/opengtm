/**
 * Live check that every configured provider returns schema-valid JSON:
 *   pnpm llm:smoke
 * Uses the real API keys in .env. Each call is tiny (well under $0.01).
 */
import { createLlm, createLogger, DECISION_TASKS, decisionProvidersFromEnv, loadConfig, providersFromEnv, systemClock, TASKS } from "@opengtm/core";
import { createTestDb } from "@opengtm/core/testing";
import { z } from "zod";

const env = process.env;
const config = loadConfig({ env });
const providers = providersFromEnv(config.llm, env);
const { db, close } = await createTestDb();
const log = createLogger("smoke", "warn");
const Schema = z.object({ segment: z.string(), confidence: z.number().min(0).max(1) });
const routes = new Map<string, { provider: string; model: string }>();
for (const t of TASKS) for (const r of config.llm.tasks[t]) if (r.model) routes.set(`${r.provider}/${r.model}`, r);

let failed = 0;
for (const [key, r] of routes) {
  if (!providers[r.provider as keyof typeof providers]?.available()) {
    console.log(`skip  ${key} (not configured)`);
    continue;
  }
  const cfg = { ...config, llm: { ...config.llm, retries: 0, tasks: { ...config.llm.tasks, icp_score: [{ provider: r.provider as "local", model: r.model, effort: "low" as const, max_tokens: 2000 }] } } };
  const llm = createLlm({ db, config: cfg, providers, clock: systemClock, log });
  try {
    const res = await llm.run("icp_score", { system: "Classify the company into a segment.", prompt: "Rivera Heating & Air, Austin TX: furnace repair and ac installation." }, Schema);
    console.log(`ok    ${key}: ${JSON.stringify(res.data)} ($${res.costUsd.toFixed(5)})`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${key}: ${(err as Error).message}`);
  }
}
// Decision models (Jev): one tiny classification per configured route.
const decisionProviders = decisionProvidersFromEnv(config.llm, env);
for (const task of DECISION_TASKS) {
  for (const r of config.llm.decisions[task] ?? []) {
    if (!decisionProviders[r.provider]?.available()) {
      console.log(`skip  ${r.provider}/${r.model} for ${task} (not configured)`);
      continue;
    }
    const llm = createLlm({ db, config: { ...config, llm: { ...config.llm, retries: 0, decisions: { [task]: [r] } } }, providers, decisionProviders, clock: systemClock, log });
    try {
      const d = await llm.decide(task, "Thanks, but we're happy with our current software. Please remove me.", {
        label: { type: "choice", instructions: "What does the sender want?", criteria: { interested: "Wants a meeting", objection: "Pushes back politely", unsubscribe: "Wants no more email" } },
      });
      console.log(`ok    ${r.provider}/${r.model} (${task}): ${JSON.stringify(d.answers.label)} ($${d.costUsd.toFixed(6)})`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${r.provider}/${r.model} (${task}): ${(err as Error).message}`);
    }
  }
}
await close();
process.exitCode = failed ? 1 : 0;
