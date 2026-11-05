import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { z } from "zod";
import type { LlmConfig } from "../config";
import { JevProvider, type DecisionProviderMap } from "./decide";
import {
  PermanentLlmError,
  TransientLlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type ProviderName,
} from "./types";

/** Parse model text as JSON, tolerating ```json fences that local models like to add. */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new PermanentLlmError(`model did not return valid JSON: ${body.slice(0, 200)}`);
  }
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic | null;

  constructor(opts: { apiKey?: string; fetch?: typeof fetch; maxRetries?: number }) {
    this.client = opts.apiKey
      ? new Anthropic({ apiKey: opts.apiKey, fetch: opts.fetch, maxRetries: opts.maxRetries ?? 0 })
      : null;
  }

  available(): boolean {
    return this.client !== null;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.client) throw new PermanentLlmError("anthropic not configured");
    try {
      const msg = await this.client.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: {
          format: zodOutputFormat(req.schema),
          ...(req.effort ? { effort: req.effort } : {}),
        },
      });
      if (msg.stop_reason === "refusal") throw new PermanentLlmError("anthropic refusal");
      if (msg.stop_reason === "max_tokens") throw new PermanentLlmError("anthropic hit max_tokens");
      if (msg.parsed_output == null) throw new PermanentLlmError("anthropic returned no parsed output");
      return {
        data: msg.parsed_output,
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        model: msg.model,
      };
    } catch (err) {
      throw classifyAnthropic(err);
    }
  }
}

function classifyAnthropic(err: unknown): Error {
  if (err instanceof PermanentLlmError || err instanceof TransientLlmError) return err;
  if (err instanceof Anthropic.RateLimitError) return new TransientLlmError(`anthropic 429: ${err.message}`);
  if (err instanceof Anthropic.InternalServerError) return new TransientLlmError(`anthropic ${err.status}: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new TransientLlmError(`anthropic connection: ${err.message}`);
  if (err instanceof Anthropic.APIError) {
    // 529 overloaded arrives as a generic APIError on some versions.
    if (err.status && err.status >= 500) return new TransientLlmError(`anthropic ${err.status}: ${err.message}`);
    return new PermanentLlmError(`anthropic ${err.status}: ${err.message}`);
  }
  return new PermanentLlmError(err instanceof Error ? err.message : String(err));
}

/** OpenAI and any OpenAI-compatible local server (Ollama, vLLM, llama.cpp). */
export class OpenAICompatibleProvider implements LlmProvider {
  private client: OpenAI | null;

  constructor(
    readonly name: "openai" | "local",
    opts: { apiKey?: string; baseURL?: string; fetch?: typeof fetch; maxRetries?: number },
  ) {
    const configured = name === "local" ? !!opts.baseURL : !!opts.apiKey;
    this.client = configured
      ? new OpenAI({
          apiKey: opts.apiKey || "local",
          baseURL: opts.baseURL,
          fetch: opts.fetch,
          maxRetries: opts.maxRetries ?? 0,
        })
      : null;
  }

  available(): boolean {
    return this.client !== null;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.client) throw new PermanentLlmError(`${this.name} not configured`);
    try {
      const res = await this.client.chat.completions.create({
        model: req.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "output", schema: jsonSchemaOf(req.schema), strict: false },
        },
        ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
        // How much the model thinks before answering; its thinking is billed as output. Checking and sorting
        // jobs get the same answers on "low" for about a third of the output tokens (measured 2026-11-04).
        ...(req.effort ? { reasoning_effort: req.effort === "max" ? "xhigh" : req.effort } : {}),
      });
      const choice = res.choices[0];
      if (!choice?.message?.content) throw new PermanentLlmError(`${this.name} returned empty content`);
      if (choice.finish_reason === "length") throw new PermanentLlmError(`${this.name} hit max tokens`);
      return {
        data: parseJsonText(choice.message.content),
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        model: res.model ?? req.model,
      };
    } catch (err) {
      if (err instanceof PermanentLlmError || err instanceof TransientLlmError) throw err;
      if (err instanceof OpenAI.RateLimitError || err instanceof OpenAI.InternalServerError || err instanceof OpenAI.APIConnectionError) {
        throw new TransientLlmError(`${this.name}: ${(err as Error).message}`);
      }
      if (err instanceof OpenAI.APIError && err.status && err.status >= 500) {
        throw new TransientLlmError(`${this.name} ${err.status}: ${err.message}`);
      }
      throw new PermanentLlmError(`${this.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  private client: GoogleGenAI | null;

  constructor(opts: { apiKey?: string }) {
    this.client = opts.apiKey ? new GoogleGenAI({ apiKey: opts.apiKey }) : null;
  }

  available(): boolean {
    return this.client !== null;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.client) throw new PermanentLlmError("gemini not configured");
    try {
      const res = await this.client.models.generateContent({
        model: req.model,
        contents: req.prompt,
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchemaOf(req.schema),
          ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
        },
      });
      const text = res.text;
      if (!text) throw new PermanentLlmError("gemini returned empty content");
      return {
        data: parseJsonText(text),
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
        model: res.modelVersion ?? req.model,
      };
    } catch (err) {
      if (err instanceof PermanentLlmError || err instanceof TransientLlmError) throw err;
      const status = (err as { status?: number }).status;
      if (status === 429 || (status !== undefined && status >= 500)) {
        throw new TransientLlmError(`gemini ${status}: ${(err as Error).message}`);
      }
      throw new PermanentLlmError(`gemini: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type ProviderMap = Partial<Record<ProviderName, LlmProvider>>;

/** Only providers listed in llm.yaml are built; an unlisted provider can never be routed to. */
export function providersFromEnv(cfg: LlmConfig, env: NodeJS.ProcessEnv): ProviderMap {
  const p = cfg.providers;
  const out: ProviderMap = {};
  if (p.anthropic) out.anthropic = new AnthropicProvider({ apiKey: env[p.anthropic.api_key_env] });
  if (p.openai) out.openai = new OpenAICompatibleProvider("openai", { apiKey: env[p.openai.api_key_env] });
  if (p.gemini) out.gemini = new GeminiProvider({ apiKey: env[p.gemini.api_key_env] });
  if (p.local) out.local = new OpenAICompatibleProvider("local", { baseURL: env[p.local.base_url_env], apiKey: env[p.local.api_key_env] });
  return out;
}

export function decisionProvidersFromEnv(cfg: LlmConfig, env: NodeJS.ProcessEnv): DecisionProviderMap {
  return cfg.providers.jev ? { jev: new JevProvider({ apiKey: env[cfg.providers.jev.api_key_env] }) } : {};
}
