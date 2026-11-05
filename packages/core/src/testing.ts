import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { Alerter, MemorySink } from "./alerts";
import { ManualClock, type Clock } from "./clock";
import { buildConfig, findRepoRoot, type Config, type DecisionTaskName, type TaskName } from "./config";
import type { Ctx } from "./ctx";
import { migrationsDir, type Db } from "./db/client";
import * as schema from "./db/schema";
import { silentLogger } from "./log";
import { validateAnswers, type DecisionAnswer, type DecisionQuestion } from "./llm/decide";
import { NoRouteError, type DecisionResult, type Llm, type LlmInput, type LlmProvider, type LlmRequest, type LlmResponse, type LlmResult, type LlmRunOptions } from "./llm/types";

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsDir() });
  return { db: db as unknown as Db, close: () => client.close() };
}

/** Repo config with synthetic values in the HUMAN fields so the full pipeline can run in tests. */
export function testConfig(mutate?: (raw: { business: any; engine: any; llm: any }) => void): Config {
  const dir = path.join(findRepoRoot(), "config");
  const read = (f: string) => parseYaml(readFileSync(path.join(dir, f), "utf8").replaceAll("${LOCAL_LLM_MODEL}", "local-test-model"));
  const raw = { business: read("business.example.yaml") as any, engine: read("engine.yaml") as any, llm: read("llm.yaml") as any };
  raw.business.company.physical_address = "100 Example Ave, Suite 1, Austin, TX 78701";
  raw.business.company.booking_link = "https://cal.example.com/intro";
  raw.business.company.proof_points = [
    { id: "pp1", text: "Northwind sends customers an automatic reminder text the day before every job" },
    { id: "pp2", text: "Northwind has one flat monthly price for the whole office with no setup fee" },
  ];
  raw.business.company.banned_claims = ["guaranteed", "/#1 scheduling/i", "award winning"];
  raw.business.senders = [{ name: "Jamie Rivera", title: "Co-founder", reply_to: "" }];
  raw.engine.alerts.channels = ["console"];
  // Tests exercise the full machinery with fixed settings, whatever production currently uses:
  // a 4-step sequence, weekday sending and approval of the first 100 emails.
  raw.engine.sequence.steps = [{ step: 1, day: 0 }, { step: 2, day: 3 }, { step: 3, day: 7 }, { step: 4, day: 14 }];
  delete raw.engine.timing.send_days;
  raw.engine.approval = { require_first_n: 100, sample_rate: 0.1, force_all: true };
  mutate?.(raw);
  return buildConfig(raw);
}

type Handler = (input: LlmInput, opts: LlmRunOptions) => unknown | Promise<unknown>;

/** Scripted LLM for pipeline tests. Validates outputs with the real schema like the router does. */
export class FakeLlm implements Llm {
  calls: { task: TaskName; input: LlmInput; opts: LlmRunOptions }[] = [];
  constructor(private handlers: Partial<Record<TaskName, Handler>> = {}) {}

  on(task: TaskName, handler: Handler): this {
    this.handlers[task] = handler;
    return this;
  }

  async run<T>(task: TaskName, input: LlmInput, schema: z.ZodType<T>, opts: LlmRunOptions = {}): Promise<LlmResult<T>> {
    this.calls.push({ task, input, opts });
    const h = this.handlers[task];
    if (!h) throw new Error(`FakeLlm: no handler for ${task}`);
    const data = schema.parse(await h(input, opts));
    return { data, provider: "local", model: "fake", costUsd: 0, promptVersion: input.promptVersion };
  }

  decisionCalls: { task: DecisionTaskName; state: string; questions: Record<string, DecisionQuestion> }[] = [];
  private decideHandlers: Partial<Record<DecisionTaskName, DecideHandler>> = {};

  /** Script a decision-model (Jev) answer. Without a handler, decide() behaves like "not configured". */
  onDecide(task: DecisionTaskName, handler: DecideHandler): this {
    this.decideHandlers[task] = handler;
    return this;
  }

  async decide(task: DecisionTaskName, state: string, questions: Record<string, DecisionQuestion>): Promise<DecisionResult> {
    const h = this.decideHandlers[task];
    if (!h) throw new NoRouteError(`FakeLlm: no decision handler for ${task}`);
    this.decisionCalls.push({ task, state, questions });
    return { answers: validateAnswers(questions, await h(state, questions)), provider: "jev", model: "fake-jev", costUsd: 0 };
  }
}

type DecideHandler = (state: string, questions: Record<string, DecisionQuestion>) => Record<string, DecisionAnswer> | Promise<Record<string, DecisionAnswer>>;

/** Scripted provider for router tests. Each call shifts the next step. */
export class ScriptedProvider implements LlmProvider {
  requests: LlmRequest[] = [];
  constructor(
    readonly name: LlmProvider["name"],
    private steps: Array<LlmResponse | Error | ((req: LlmRequest) => LlmResponse)>,
    private isAvailable = true,
  ) {}
  available() {
    return this.isAvailable;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const step = this.steps.length > 1 ? this.steps.shift() : this.steps[0];
    if (!step) throw new Error("ScriptedProvider: no steps");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(req) : step;
  }
}

export interface TestCtx extends Ctx {
  clock: ManualClock;
  sink: MemorySink;
  close: () => Promise<void>;
}

export async function createTestCtx(
  opts: { config?: Config; llm?: Llm; start?: string; clock?: Clock; random?: () => number } = {},
): Promise<TestCtx> {
  const { db, close } = await createTestDb();
  const clock = new ManualClock(opts.start ?? "2026-10-20T15:00:00Z"); // Tue 10:00 Central
  const sink = new MemorySink();
  const config = opts.config ?? testConfig();
  return {
    db,
    config,
    llm: opts.llm ?? new FakeLlm(),
    clock,
    log: silentLogger,
    alerts: new Alerter(db, [sink], clock, silentLogger),
    env: {},
    random: opts.random ?? seededRandom(42),
    sink,
    close,
  };
}

/** Deterministic PRNG (mulberry32) so simulations are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
