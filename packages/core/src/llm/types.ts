import type { z } from "zod";
import type { DecisionTaskName, LlmRoute, TaskName } from "../config";
import type { DecisionAnswer, DecisionQuestion } from "./decide";

export type ProviderName = LlmRoute["provider"];

export interface LlmRequest {
  system: string;
  prompt: string;
  schema: z.ZodType;
  model: string;
  effort?: LlmRoute["effort"];
  maxTokens?: number;
}

export interface LlmResponse {
  /** Parsed JSON (not yet validated by the router). */
  data: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LlmProvider {
  readonly name: ProviderName;
  available(): boolean;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Worth retrying on the same route (rate limit, 5xx, network). */
export class TransientLlmError extends Error {}
/** Not worth retrying on the same route (bad request, auth, refusal); try the next route. */
export class PermanentLlmError extends Error {}
export class NoRouteError extends Error {}
export class LlmExhaustedError extends Error {
  constructor(
    readonly task: TaskName | DecisionTaskName,
    readonly attempts: string[],
  ) {
    super(`all routes failed for ${task}: ${attempts.join(" | ")}`);
  }
}

export interface LlmInput {
  system: string;
  prompt: string;
  promptVersion?: string;
}

export interface LlmRunOptions {
  companyId?: string | null;
  /** Rough expected output tokens, used for the pre-call spend check. */
  expectedOutputTokens?: number;
}

export interface LlmResult<T> {
  data: T;
  provider: ProviderName;
  model: string;
  costUsd: number;
  promptVersion?: string;
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  provider: string;
  model: string;
  costUsd: number;
}

export interface Llm {
  run<T>(task: TaskName, input: LlmInput, schema: z.ZodType<T>, opts?: LlmRunOptions): Promise<LlmResult<T>>;
  /** Classification on a decision model (Jev). Throws NoRouteError when none is configured. */
  decide(task: DecisionTaskName, state: string, questions: Record<string, DecisionQuestion>, opts?: LlmRunOptions): Promise<DecisionResult>;
}
