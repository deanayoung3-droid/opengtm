import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AnthropicProvider,
  createLlm,
  GeminiProvider,
  LlmExhaustedError,
  llmCalls,
  OpenAICompatibleProvider,
  PermanentLlmError,
  silentLogger,
  spendLedger,
  SpendCapError,
  TransientLlmError,
  type Db,
} from "../src/index";
import { createTestDb, ScriptedProvider, testConfig } from "../src/testing";
import { ManualClock } from "../src/clock";
const ManualClockFor = () => new ManualClock("2026-10-20T15:00:00Z");

const Score = z.object({ score: z.number().int().min(0).max(100), reason: z.string() });
const sampleJson = { score: 82, reason: "hvac company, 4 technicians, TX" };
const input = { system: "Score this company.", prompt: "Company: Example Heating & Air, Austin TX", promptVersion: "icp_score@v1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("LLM router", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await close();
  });

  describe("each provider returns schema-valid JSON on a sample task", () => {
    it("anthropic (SDK, structured output)", async () => {
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("claude-haiku-5-5");
        expect(body.output_config.format.type).toBe("json_schema");
        expect(body.output_config.effort).toBe("low");
        return jsonResponse({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text: JSON.stringify(sampleJson) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 30 },
        });
      });
      const provider = new AnthropicProvider({ apiKey: "test", fetch: fetchMock as unknown as typeof fetch });
      const res = await provider.complete({ ...input, schema: Score, model: "claude-haiku-5-5", effort: "low" });
      expect(Score.parse(res.data)).toEqual(sampleJson);
      expect(res.inputTokens).toBe(120);
    });

    it("anthropic refusal is a permanent error (router falls back)", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          id: "msg_2", type: "message", role: "assistant", model: "claude-haiku-5-5",
          content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
        }),
      );
      const provider = new AnthropicProvider({ apiKey: "test", fetch: fetchMock as unknown as typeof fetch });
      await expect(provider.complete({ ...input, schema: Score, model: "claude-haiku-5-5" })).rejects.toBeInstanceOf(PermanentLlmError);
    });

    it("anthropic 429 is transient", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429));
      const provider = new AnthropicProvider({ apiKey: "test", fetch: fetchMock as unknown as typeof fetch });
      await expect(provider.complete({ ...input, schema: Score, model: "claude-haiku-5-5" })).rejects.toBeInstanceOf(TransientLlmError);
    });

    it.each(["openai", "local"] as const)("%s (chat completions json_schema)", async (name) => {
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        if (name === "local") expect(String(url)).toContain("http://127.0.0.1:11434/v1");
        const body = JSON.parse(String(init?.body));
        expect(body.response_format.type).toBe("json_schema");
        return jsonResponse({
          id: "c1", object: "chat.completion", created: 1, model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "```json\n" + JSON.stringify(sampleJson) + "\n```" } }],
          usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
        });
      });
      const provider = new OpenAICompatibleProvider(name, {
        apiKey: "k",
        baseURL: name === "local" ? "http://127.0.0.1:11434/v1" : undefined,
        fetch: fetchMock as unknown as typeof fetch,
      });
      const res = await provider.complete({ ...input, schema: Score, model: "m" });
      expect(Score.parse(res.data)).toEqual(sampleJson);
      expect(res.outputTokens).toBe(12);
    });

    it("openai gets the route's reasoning effort (checking jobs run on low)", async () => {
      const sent: Record<string, unknown>[] = [];
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        sent.push(body);
        return jsonResponse({
          id: "c1", object: "chat.completion", created: 1, model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(sampleJson) } }],
          usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
        });
      });
      const provider = new OpenAICompatibleProvider("openai", { apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
      await provider.complete({ ...input, schema: Score, model: "m", effort: "low" });
      await provider.complete({ ...input, schema: Score, model: "m" });
      expect(sent[0]!.reasoning_effort).toBe("low");
      expect(sent[1]).not.toHaveProperty("reasoning_effort");
    });

    it("gemini (@google/genai, responseJsonSchema)", async () => {
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.generationConfig.responseMimeType).toBe("application/json");
        return jsonResponse({
          candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(sampleJson) }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9 },
          modelVersion: "gemini-2.5-flash",
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const provider = new GeminiProvider({ apiKey: "g" });
      const res = await provider.complete({ ...input, schema: Score, model: "gemini-2.5-flash" });
      expect(Score.parse(res.data)).toEqual(sampleJson);
      expect(res.inputTokens).toBe(40);
    });
  });

  function router(providers: Record<string, ScriptedProvider>, mutate?: Parameters<typeof testConfig>[0]) {
    const config = testConfig((raw) => {
      raw.llm.tasks.icp_score = [
        { provider: "local", model: "llama-test" },
        { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" },
      ];
      raw.llm.pricing["claude-haiku-5-5"] = { in: 0.1, out: 0.5 }; // router behavior, not production routing
      mutate?.(raw);
    });
    return createLlm({ db, config, providers, clock: ManualClockFor(), log: silentLogger, sleep: async () => {} });
  }

  const ok = (data: unknown = sampleJson, inTok = 1000, outTok = 200) => ({ data, inputTokens: inTok, outputTokens: outTok, model: "m" });

  it("fallback fires when the primary errors", async () => {
    const local = new ScriptedProvider("local", [new PermanentLlmError("model not loaded")]);
    const anthropic = new ScriptedProvider("anthropic", [ok()]);
    const res = await router({ local, anthropic }).run("icp_score", input, Score);
    expect(res.provider).toBe("anthropic");
    expect(res.data).toEqual(sampleJson);
    const calls = await db.select().from(llmCalls);
    expect(calls.map((c) => [c.provider, c.ok])).toEqual([["local", false], ["anthropic", true]]);
  });

  it("retries transient errors on the same route before falling back", async () => {
    const local = new ScriptedProvider("local", [new TransientLlmError("503"), ok()]);
    const anthropic = new ScriptedProvider("anthropic", [ok()]);
    const res = await router({ local, anthropic }).run("icp_score", input, Score);
    expect(res.provider).toBe("local");
    expect(anthropic.requests).toHaveLength(0);
  });

  it("schema-invalid output gets one re-ask, then falls back", async () => {
    const local = new ScriptedProvider("local", [ok({ score: "high" })]);
    const anthropic = new ScriptedProvider("anthropic", [ok()]);
    const res = await router({ local, anthropic }).run("icp_score", input, Score);
    expect(local.requests).toHaveLength(2);
    expect(res.provider).toBe("anthropic");
  });

  it("skips unconfigured providers and routes with empty model names", async () => {
    const local = new ScriptedProvider("local", [ok()], false);
    const anthropic = new ScriptedProvider("anthropic", [ok()]);
    const res = await router({ local, anthropic }).run("icp_score", input, Score);
    expect(res.provider).toBe("anthropic");
  });

  it("throws LlmExhaustedError when every route fails", async () => {
    const local = new ScriptedProvider("local", [new PermanentLlmError("a")]);
    const anthropic = new ScriptedProvider("anthropic", [new PermanentLlmError("b")]);
    await expect(router({ local, anthropic }).run("icp_score", input, Score)).rejects.toBeInstanceOf(LlmExhaustedError);
  });

  it("logs cost per call to llm_calls and spend_ledger (local is free)", async () => {
    const local = new ScriptedProvider("local", [new PermanentLlmError("x")]);
    const anthropic = new ScriptedProvider("anthropic", [ok(sampleJson, 10_000, 2_000)]);
    const res = await router({ local, anthropic }).run("icp_score", input, Score, { companyId: crypto.randomUUID() });
    // haiku 5.5: $0.10/M in, $0.50/M out
    expect(res.costUsd).toBeCloseTo((0.1 * 10_000 + 0.5 * 2_000) / 1e6, 10);
    const spend = await db.select().from(spendLedger);
    expect(spend).toHaveLength(1);
    expect(spend[0]!.amountUsd).toBeCloseTo(res.costUsd, 10);
  });

  it("enforces the per-lead LLM cap and does not fall back around it", async () => {
    const companyId = crypto.randomUUID();
    await db.insert(llmCalls).values({ task: "write_email", provider: "anthropic", model: "claude-opus-5-5", costUsd: 0.15, ok: true, companyId });
    const local = new ScriptedProvider("local", [new PermanentLlmError("down")]);
    const anthropic = new ScriptedProvider("anthropic", [ok()]);
    await expect(router({ local, anthropic }).run("icp_score", input, Score, { companyId })).rejects.toBeInstanceOf(SpendCapError);
    expect(anthropic.requests).toHaveLength(0);
  });

  it("enforces the daily spend cap", async () => {
    await db.insert(spendLedger).values({ category: "verify", amountUsd: 25, createdAt: ManualClockFor().now() });
    const local = new ScriptedProvider("local", [ok()], false);
    const anthropic = new ScriptedProvider("anthropic", [ok()]);
    await expect(router({ local, anthropic }).run("icp_score", input, Score)).rejects.toBeInstanceOf(SpendCapError);
  });
});
