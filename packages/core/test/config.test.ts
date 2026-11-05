import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigError, findRepoRoot, humanTodos, loadConfig, sendingBlockers } from "../src/index";
import { testConfig } from "../src/testing";

describe("config loader", () => {
  it("loads and validates the repo config (the shipped example until setup writes business.yaml)", () => {
    const cfg = loadConfig({ env: {}, dir: undefined });
    expect(cfg.business.company.name).toBeTruthy();
    expect(cfg.business.icp.segments.length).toBeGreaterThan(0);
    expect(Object.keys(cfg.llm.providers)).toEqual(["openai"]);
    for (const routes of Object.values(cfg.llm.tasks)) expect(routes.map((r) => r.provider)).toEqual(["openai"]);
    expect(cfg.llm.decisions).toEqual({});
    expect(cfg.engine.qualify.max_company_size).toBe(50);
    expect(cfg.logos).toEqual({ light: null, dark: null });
  });

  it("the example business can't send until a real address and sender are filled in", () => {
    const example = loadConfig({ env: {}, dir: undefined });
    if (example.business.company.site.includes(".example.")) {
      expect(sendingBlockers(example).map((t) => t.field)).toEqual(expect.arrayContaining(["company.physical_address", "senders"]));
    }
  });

  it("reports HUMAN fields and blocks sending until address + sender are set", () => {
    const cfg = testConfig((raw) => {
      raw.business.company.physical_address = "";
    });
    expect(humanTodos(cfg).map((t) => t.field)).toContain("company.physical_address");
    expect(sendingBlockers(cfg).map((t) => t.field)).toEqual(["company.physical_address"]);
    expect(sendingBlockers(testConfig())).toEqual([]);
  });

  it("ships example model configs that load", () => {
    for (const f of ["llm.anthropic.yaml", "llm.local.yaml"]) {
      const cfg = testConfig((raw) => {
        raw.llm = parseYaml(readFileSync(path.join(findRepoRoot(), "config/examples", f), "utf8").replaceAll("${LOCAL_LLM_MODEL}", "local-test-model"));
      });
      expect(Object.keys(cfg.llm.tasks)).toContain("write_email");
    }
  });

  it("normalizes string proof points to ids", () => {
    const cfg = testConfig((raw) => {
      raw.business.company.proof_points = ["Fact one", "Fact two"];
    });
    expect(cfg.proofPoints).toEqual([
      { id: "pp1", text: "Fact one" },
      { id: "pp2", text: "Fact two" },
    ]);
  });

  it("rejects non-US geo and malformed values", () => {
    expect(() => testConfig((raw) => (raw.business.icp.geo = ["US", "UK"]))).toThrow(ConfigError);
    expect(() => testConfig((raw) => (raw.engine.timing.business_start = "9am"))).toThrow(ConfigError);
    expect(() => testConfig((raw) => (raw.engine.writer.min_words = 200))).toThrow(ConfigError);
  });
});
