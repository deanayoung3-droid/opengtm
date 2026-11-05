import type { z } from "zod";
import type { Clock } from "../clock";
import type { Config, DecisionTaskName, TaskName } from "../config";
import type { Db } from "../db/client";
import { llmCalls } from "../db/schema";
import type { Logger } from "../log";
import { assertDailySpendOk, leadLlmSpend, recordSpend, SpendCapError } from "../spend";
import type { DecisionProviderMap, DecisionQuestion } from "./decide";
import type { ProviderMap } from "./providers";
import {
  LlmExhaustedError,
  NoRouteError,
  PermanentLlmError,
  TransientLlmError,
  type DecisionResult,
  type Llm,
  type LlmInput,
  type LlmResult,
  type LlmRunOptions,
} from "./types";

export interface RouterDeps {
  db: Db;
  config: Config;
  providers: ProviderMap;
  /** Classification models (Jev). Optional: decision tasks then fall back to their LLM route. */
  decisionProviders?: DecisionProviderMap;
  clock: Clock;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function priceFor(config: Config, route: { provider: string; model: string }): { in: number; out: number } {
  if (route.provider === "local") return { in: 0, out: 0 };
  const exact = config.llm.pricing[route.model];
  if (exact) return exact;
  // Unknown API model: assume the most expensive known price so caps stay safe.
  const all = Object.values(config.llm.pricing);
  return {
    in: Math.max(0, ...all.map((p) => p.in)),
    out: Math.max(0, ...all.map((p) => p.out)),
  };
}

export function costOf(price: { in: number; out: number }, inTok: number, outTok: number): number {
  return (price.in * inTok + price.out * outTok) / 1_000_000;
}

/**
 * `llm.run(task, input, schema)`: routes a task to its configured provider+model,
 * retries transient errors, falls back to the next route, validates output with
 * the zod schema, enforces spend caps, and logs every call to `llm_calls`.
 */
export function createLlm(deps: RouterDeps): Llm {
  const { db, config, providers, clock, log } = deps;
  const sleep = deps.sleep ?? defaultSleep;

  async function logCall(
    task: TaskName | DecisionTaskName,
    route: { provider: string; model: string },
    r: { inTok: number; outTok: number; cost: number; latency: number; ok: boolean; error?: string },
    opts: LlmRunOptions,
    promptVersion?: string,
  ) {
    await db.insert(llmCalls).values({
      task,
      provider: route.provider,
      model: route.model,
      inputTokens: r.inTok,
      outputTokens: r.outTok,
      costUsd: r.cost,
      latencyMs: r.latency,
      ok: r.ok,
      error: r.error?.slice(0, 500) ?? null,
      companyId: opts.companyId ?? null,
      promptVersion: promptVersion ?? null,
      createdAt: clock.now(),
    });
    if (r.cost > 0) {
      await recordSpend(db, "llm", r.cost, { companyId: opts.companyId, ref: `${task}:${route.model}`, at: clock.now() });
    }
  }

  async function checkCaps(route: { provider: string; model: string }, inputChars: number, opts: LlmRunOptions) {
    const price = priceFor(config, route);
    const estIn = Math.ceil(inputChars / 3.5);
    const estimate = costOf(price, estIn, opts.expectedOutputTokens ?? 1500);
    await assertDailySpendOk(db, clock.now(), config.engine.caps.daily_spend_cap_usd, estimate);
    if (opts.companyId && estimate > 0) {
      const spent = await leadLlmSpend(db, opts.companyId);
      const cap = config.engine.caps.per_lead_llm_cap_usd;
      if (spent + estimate > cap) {
        throw new SpendCapError(`per-lead LLM cap: spent $${spent.toFixed(4)} + est $${estimate.toFixed(4)} > $${cap}`, "lead");
      }
    }
  }

  return {
    async run<T>(task: TaskName, input: LlmInput, schema: z.ZodType<T>, opts: LlmRunOptions = {}): Promise<LlmResult<T>> {
      const routes = config.llm.tasks[task].filter((r) => r.model.trim() && providers[r.provider]?.available());
      if (routes.length === 0) throw new NoRouteError(`no configured provider for task ${task}`);
      const attempts: string[] = [];

      for (const route of routes) {
        const provider = providers[route.provider]!;
        const price = priceFor(config, route);
        let schemaRetryUsed = false;
        for (let attempt = 0; attempt <= config.llm.retries; attempt++) {
          await checkCaps(route, input.system.length + input.prompt.length, opts); // SpendCapError propagates: never fall back around a cap.
          const started = Date.now();
          try {
            const res = await provider.complete({
              system: input.system,
              prompt: input.prompt,
              schema,
              model: route.model,
              effort: route.effort,
              maxTokens: route.max_tokens,
            });
            const cost = costOf(price, res.inputTokens, res.outputTokens);
            const parsed = schema.safeParse(res.data);
            if (!parsed.success) {
              const error = `schema mismatch: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
              await logCall(task, route, { inTok: res.inputTokens, outTok: res.outputTokens, cost, latency: Date.now() - started, ok: false, error }, opts, input.promptVersion);
              attempts.push(`${route.provider}/${route.model}: ${error}`);
              if (!schemaRetryUsed) {
                schemaRetryUsed = true;
                continue; // one free re-ask on the same route, then fall back
              }
              break;
            }
            await logCall(task, route, { inTok: res.inputTokens, outTok: res.outputTokens, cost, latency: Date.now() - started, ok: true }, opts, input.promptVersion);
            return { data: parsed.data, provider: route.provider, model: res.model, costUsd: cost, promptVersion: input.promptVersion };
          } catch (err) {
            if (err instanceof SpendCapError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            await logCall(task, route, { inTok: 0, outTok: 0, cost: 0, latency: Date.now() - started, ok: false, error: message }, opts, input.promptVersion);
            attempts.push(`${route.provider}/${route.model}: ${message}`);
            if (err instanceof TransientLlmError && attempt < config.llm.retries) {
              const backoff = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
              log.warn({ task, route: route.model, attempt, backoff }, "transient LLM error, retrying");
              await sleep(backoff);
              continue;
            }
            if (!(err instanceof PermanentLlmError) && !(err instanceof TransientLlmError)) {
              log.error({ err, task }, "unexpected provider error");
            }
            break; // next route
          }
        }
        log.warn({ task, failed: `${route.provider}/${route.model}` }, "falling back to next LLM route");
      }
      throw new LlmExhaustedError(task, attempts);
    },

    async decide(task: DecisionTaskName, state: string, questions: Record<string, DecisionQuestion>, opts: LlmRunOptions = {}): Promise<DecisionResult> {
      const decisionProviders = deps.decisionProviders ?? {};
      const routes = (config.llm.decisions[task] ?? []).filter((r) => r.model.trim() && decisionProviders[r.provider]?.available());
      if (routes.length === 0) throw new NoRouteError(`no decision provider for task ${task}`);
      const attempts: string[] = [];
      const inputChars = state.length + JSON.stringify(questions).length;

      for (const route of routes) {
        const provider = decisionProviders[route.provider]!;
        const price = priceFor(config, route);
        for (let attempt = 0; attempt <= config.llm.retries; attempt++) {
          await checkCaps(route, inputChars, { ...opts, expectedOutputTokens: 0 });
          const started = Date.now();
          try {
            const res = await provider.decide({ model: route.model, state, questions });
            const cost = costOf(price, res.inputTokens, res.outputTokens);
            await logCall(task, route, { inTok: res.inputTokens, outTok: res.outputTokens, cost, latency: Date.now() - started, ok: true }, opts);
            return { answers: res.answers, provider: route.provider, model: res.model, costUsd: cost };
          } catch (err) {
            if (err instanceof SpendCapError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            await logCall(task, route, { inTok: 0, outTok: 0, cost: 0, latency: Date.now() - started, ok: false, error: message }, opts);
            attempts.push(`${route.provider}/${route.model}: ${message}`);
            if (err instanceof TransientLlmError && attempt < config.llm.retries) {
              await sleep(Math.min(30_000, 1000 * 2 ** attempt));
              continue;
            }
            break;
          }
        }
      }
      throw new LlmExhaustedError(task, attempts);
    },
  };
}
