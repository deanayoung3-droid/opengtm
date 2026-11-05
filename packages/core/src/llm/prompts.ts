import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { findRepoRoot } from "../config";

export interface Prompt {
  name: string;
  /** e.g. "write_email@v2"; stored on every message/llm call. */
  version: string;
  system: string;
  user: string;
}

const cache = new Map<string, Prompt>();

/**
 * Prompts live in /prompts/<name>.md:
 *
 *   ---
 *   version: 2
 *   ---
 *   <system prompt>
 *   ---user---
 *   <user template with {{vars}}>
 */
export function loadPrompt(name: string, dir = process.env.GTM_PROMPTS_DIR ?? path.join(findRepoRoot(), "prompts")): Prompt {
  const key = `${dir}/${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = readFileSync(path.join(dir, `${name}.md`), "utf8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) throw new Error(`prompt ${name}: missing front matter`);
  const meta = parseYaml(fm[1]!) as { version?: number };
  if (!meta.version) throw new Error(`prompt ${name}: front matter needs a version`);
  const [system, user] = fm[2]!.split(/^---user---$/m);
  if (!system || user === undefined) throw new Error(`prompt ${name}: needs a ---user--- divider`);
  const prompt = { name, version: `${name}@v${meta.version}`, system: system.trim(), user: user.trim() };
  cache.set(key, prompt);
  return prompt;
}

export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`template variable {{${k}}} not provided`);
    return String(vars[k]);
  });
}

/** Variables every prompt may use about the sending company, from business.yaml (and Project docs). */
export function brandVars(config: { business: { company: { name: string; one_liner: string }; outreach: { cta_reply: string } } }): Record<string, string> {
  return { company_name: config.business.company.name, one_liner: config.business.company.one_liner, cta_reply: config.business.outreach.cta_reply };
}
