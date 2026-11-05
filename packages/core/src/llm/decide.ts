import { PermanentLlmError, TransientLlmError } from "./types";

/**
 * Decision models (TypeSafe Jev) answer typed questions about a state instead of
 * generating text: pick a choice, score on a scale, or judge a statement (noul).
 * They are far cheaper and faster than an LLM for pure classification.
 */
export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

export type DecisionAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities?: Record<string, number> }
  | { type: "noul"; noul: number };

export interface DecisionRequest {
  model: string;
  state: string;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export type DecisionProviderName = "jev";

export interface DecisionProvider {
  readonly name: DecisionProviderName;
  available(): boolean;
  decide(req: DecisionRequest): Promise<DecisionResponse>;
}

export type DecisionProviderMap = Partial<Record<DecisionProviderName, DecisionProvider>>;

/** Check that every question got an answer of the right type, and choices are from the criteria. */
export function validateAnswers(questions: Record<string, DecisionQuestion>, answers: Record<string, DecisionAnswer> | undefined): Record<string, DecisionAnswer> {
  if (!answers) throw new PermanentLlmError("decision response had no answers");
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a || a.type !== q.type) throw new PermanentLlmError(`decision answer missing or wrong type for ${id}`);
    if (a.type === "choice" && q.type === "choice" && !(a.choice in q.criteria)) throw new PermanentLlmError(`decision chose unknown option ${a.choice} for ${id}`);
    if (a.type === "noul" && (a.noul < 0 || a.noul > 1)) throw new PermanentLlmError(`noul out of range for ${id}`);
  }
  return answers;
}

/** TypeSafe Jev: POST https://api.typesafe.ai/v1/systemone (docs.typesafe.ai). */
export class JevProvider implements DecisionProvider {
  readonly name = "jev" as const;
  constructor(private opts: { apiKey?: string; baseUrl?: string; fetch?: typeof fetch }) {}

  available(): boolean {
    return !!this.opts.apiKey;
  }

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    if (!this.opts.apiKey) throw new PermanentLlmError("jev not configured");
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl ?? "https://api.typesafe.ai"}/v1/systemone`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ state: req.state, model: req.model, questions: req.questions }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new TransientLlmError(`jev network: ${(err as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) throw new TransientLlmError(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (!res.ok) throw new PermanentLlmError(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { model?: string; answers?: Record<string, DecisionAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };
    return {
      answers: validateAnswers(req.questions, body.answers),
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      model: body.model ?? req.model,
    };
  }
}
