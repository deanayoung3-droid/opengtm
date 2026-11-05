#!/usr/bin/env node
/**
 * Guided setup:  node scripts/setup.mjs   (or `pnpm run setup`)
 *
 * Writes .env (database password, dashboard login, unsubscribe secret, your AI key, time zone), points
 * config/llm.yaml at your AI provider, and writes config/business.yaml: either drafted from your website
 * by the AI (you review it) or from a few questions. Safe to run again: existing secrets are kept, and
 * nothing is overwritten without asking. Needs only Node 22+ (no packages), so it can run before
 * `pnpm install` or Docker.
 *
 *   --yes        accept every default without asking (keys can come from the environment)
 *   --business   (re)write config/business.yaml even if it exists
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const YES = args.has("--yes") || args.has("-y");
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const secret = (n = 24) => randomBytes(n).toString("base64url");

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(`Node 22 or newer is needed (you have ${process.versions.node}). Get it from https://nodejs.org.`);
  process.exit(1);
}

// ---------- prompts ----------
const out = new Writable({
  write(chunk, enc, cb) {
    if (!out.muted) process.stdout.write(chunk, enc);
    cb();
  },
});
const rl = readline.createInterface({ input: process.stdin, output: out, terminal: !!process.stdin.isTTY });
// Answers are queued as lines arrive, so typed and piped input (e.g. a script feeding answers) both work.
const queue = [];
const waiters = [];
let closed = false;
rl.on("line", (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
rl.on("close", () => {
  closed = true;
  while (waiters.length) waiters.shift()("");
});
const nextLine = () => (queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve("") : new Promise((r) => waiters.push(r)));

async function ask(question, def = "", { hidden = false } = {}) {
  if (YES) return def;
  const hint = def && !hidden ? dim(` [${def}]`) : hidden && def ? dim(" [keep current]") : "";
  process.stdout.write(`${question}${hint}: `);
  out.muted = hidden;
  const a = await nextLine();
  out.muted = false;
  if (hidden || !process.stdin.isTTY) process.stdout.write("\n");
  return a.trim() || def;
}
async function yesNo(question, def = true) {
  const a = (await ask(`${question} ${dim(def ? "(Y/n)" : "(y/N)")}`, "")).toLowerCase();
  return a ? a.startsWith("y") : def;
}
async function choose(question, options, def) {
  for (;;) {
    const a = (await ask(`${question} (${options.join(" / ")})`, def)).toLowerCase();
    if (options.includes(a)) return a;
    console.log(yellow(`  Please answer one of: ${options.join(", ")}`));
  }
}

// ---------- .env ----------
const envPath = path.join(root, ".env");
const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(path.join(root, ".env.example"), "utf8");
const env = Object.fromEntries(
  envText
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/\s+#.*$/, "").trim()]),
);
const fromProcess = (k) => process.env[k]?.trim() || "";
const changes = {};
const set = (k, v) => {
  if (v !== undefined && v !== env[k]) changes[k] = v;
};
const current = (k) => changes[k] ?? env[k] ?? "";

console.log(`\n${bold("OpenGTM setup")}\n${dim("Press Enter to accept the value in [brackets]. Run this again any time.")}\n`);

// Secrets that must exist and never change once set.
if (!current("POSTGRES_PASSWORD")) set("POSTGRES_PASSWORD", secret());
if (!current("UNSUBSCRIBE_SECRET")) set("UNSUBSCRIBE_SECRET", secret(32));

console.log(bold("1. Dashboard login"));
set("DASHBOARD_USER", await ask("  Username", current("DASHBOARD_USER") || "admin"));
let newPassword = "";
if (!current("DASHBOARD_PASSWORD")) {
  newPassword = secret(18);
  set("DASHBOARD_PASSWORD", newPassword);
  console.log(`  Generated a password (also saved in .env): ${bold(newPassword)}`);
} else console.log(dim("  Keeping the password already in .env."));

console.log(`\n${bold("2. AI model")} ${dim("(writes the emails, reads replies, researches companies)")}`);
const existingProvider = current("ANTHROPIC_API_KEY") && !current("OPENAI_API_KEY") ? "anthropic" : current("LOCAL_LLM_BASE_URL") && !current("OPENAI_API_KEY") ? "local" : "openai";
const provider = await choose("  Provider", ["openai", "anthropic", "local"], existingProvider);
let aiKey = "";
if (provider === "openai") {
  aiKey = await ask("  OpenAI API key (platform.openai.com/api-keys)", current("OPENAI_API_KEY") || fromProcess("OPENAI_API_KEY"), { hidden: true });
  set("OPENAI_API_KEY", aiKey);
} else if (provider === "anthropic") {
  aiKey = await ask("  Anthropic API key (console.anthropic.com)", current("ANTHROPIC_API_KEY") || fromProcess("ANTHROPIC_API_KEY"), { hidden: true });
  set("ANTHROPIC_API_KEY", aiKey);
  copyFileSync(path.join(root, "config/examples/llm.anthropic.yaml"), path.join(root, "config/llm.yaml"));
  console.log(`  Using config/examples/llm.anthropic.yaml as config/llm.yaml. ${yellow("Add your model prices under `pricing:` there so the daily spend cap counts AI spend.")}`);
} else {
  set("LOCAL_LLM_BASE_URL", await ask("  OpenAI-compatible server URL", current("LOCAL_LLM_BASE_URL") || "http://host.docker.internal:11434/v1"));
  set("LOCAL_LLM_API_KEY", current("LOCAL_LLM_API_KEY") || "local");
  set("LOCAL_LLM_MODEL", await ask("  Model name", current("LOCAL_LLM_MODEL") || "llama3.1"));
  copyFileSync(path.join(root, "config/examples/llm.local.yaml"), path.join(root, "config/llm.yaml"));
  console.log("  Using config/examples/llm.local.yaml as config/llm.yaml.");
}
if (!aiKey && provider !== "local") console.log(yellow("  No key yet: the app runs, but can't write emails until you add it to .env."));

console.log(`\n${bold("3. Where and when")}`);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
set("TEAM_TIMEZONE", await ask("  Your team's time zone", current("TEAM_TIMEZONE") || tz));
set("PUBLIC_BASE_URL", await ask(`  Public URL of the dashboard, if you have one ${dim("(e.g. https://gtm.yourcompany.com; blank for now)")}`, current("PUBLIC_BASE_URL")));

console.log(`\n${bold("4. Optional services")} ${dim("(blank = skip; add them to .env later)")}`);
set("ZEROBOUNCE_API_KEY", await ask(`  ZeroBounce key ${dim("(email verification, strongly recommended before real sending)")}`, current("ZEROBOUNCE_API_KEY"), { hidden: true }));
const ark = await ask(`  AI Ark key ${dim("(lead search; or import leads from a CSV instead)")}`, current("AI_ARK_API_KEY"), { hidden: true });
set("AI_ARK_API_KEY", ark);
if (ark && current("AI_ARK_TERMS_OK") !== "1") {
  const ok = await yesNo("  Have you read AI Ark's terms and confirmed outbound email use is allowed?", false);
  set("AI_ARK_TERMS_OK", ok ? "1" : "0");
}

// Write .env, keeping every line and comment that was there.
let text = envText;
for (const [k, v] of Object.entries(changes)) {
  const line = `${k}=${v}`;
  const re = new RegExp(`^\\s*#?\\s*${k}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}
writeFileSync(envPath, text, { mode: 0o600 });
console.log(green(`\n✓ Saved .env`) + dim(" (keep it private; it is in .gitignore)"));

// ---------- business.yaml ----------
const businessPath = path.join(root, "config/business.yaml");
if (!existsSync(businessPath) || args.has("--business")) {
  console.log(`\n${bold("5. Your business")} ${dim("(what the AI may say about you; editable later in the dashboard's Project docs)")}`);
  const site = normalizeUrl(await ask("  Your company website", ""));
  let draft = null;
  if (site && aiKey && provider !== "local" && (await yesNo("  Draft your business profile from your website with AI? You review it after.", true))) {
    try {
      process.stdout.write(dim("  Reading your site and drafting... "));
      draft = await draftFromWebsite(site, provider, aiKey);
      console.log(green("done"));
    } catch (err) {
      console.log(yellow(`couldn't (${err.message}). Asking a few questions instead.`));
    }
  }
  draft ??= {};
  const name = await ask("  Company name", draft.name || (site ? new URL(site).hostname.replace(/^www\./, "").split(".")[0] : ""));
  const oneLiner = await ask("  What you sell, in one line", draft.one_liner || "");
  const address = await ask(`  Postal address ${dim("(required by law in every email, CAN-SPAM)")}`, "");
  const sender = await ask(`  Sender name for the first mailbox ${dim("(a real person or a name your company approved)")}`, "");
  const senderTitle = await ask("  Their title", "");
  const booking = await ask(`  Booking link for calls ${dim("(e.g. https://cal.com/you/intro; blank for now)")}`, "");
  if (!name || !site || !oneLiner) {
    console.log(yellow("  Skipped config/business.yaml (it needs at least a name, website and one-liner).") + dim(" The app runs on the example company, which can't send, until you add yours in the dashboard (Project docs) or run this again."));
  } else {
    writeFileSync(businessPath, businessYaml({ ...draft, name, site, one_liner: oneLiner, physical_address: address, booking_link: booking, senders: [{ name: sender, title: senderTitle }] }, !!draft.name));
    console.log(green("✓ Wrote config/business.yaml") + (draft.name ? yellow("  Review it: every proof point must be true.") : dim("  Fill in proof points and campaigns there or in the dashboard.")));
  }
} else console.log(dim("\nKeeping config/business.yaml (run with --business to redo it)."));

// ---------- next steps ----------
const hasDocker = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const port = current("APP_PORT") || "8080";
console.log(`\n${bold("Next")}`);
if (!hasDocker) console.log(`  ${yellow("Docker isn't installed or running.")} Get Docker Desktop (docker.com) or Docker Engine, then:`);
console.log(`  ${bold("docker compose up -d")}          ${dim("start the app (first build takes a few minutes)")}`);
console.log(`  open ${bold(`http://localhost:${port}`)}   ${dim(`sign in as ${current("DASHBOARD_USER")}${newPassword ? ` / ${newPassword}` : " with the password in .env"}`)}`);
console.log(`  Then follow the checklist on the dashboard: Project docs, mailboxes (Channels), campaigns. ${dim("Guide: docs/SETUP.md")}\n`);
rl.close();

// ---------- helpers ----------
function normalizeUrl(u) {
  if (!u) return "";
  const withProto = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  try {
    return new URL(withProto).origin;
  } catch {
    return "";
  }
}

async function pageText(url) {
  const res = await fetch(url, { headers: { "user-agent": "OpenGTM-Setup/1.0" }, signal: AbortSignal.timeout(15000), redirect: "follow" });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return "";
  const html = await res.text();
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function draftFromWebsite(site, provider, key) {
  const pages = [];
  for (const p of ["", "/about", "/pricing", "/features"]) {
    const t = await pageText(site + p).catch(() => "");
    if (t) pages.push(`<page url="${site + p}">\n${t.slice(0, 6000)}\n</page>`);
  }
  if (!pages.length) throw new Error("the site didn't load");
  const instructions = `You set up an outbound email tool for the company whose website pages are below. Draft its business profile as JSON with these keys:
name, one_liner (what they sell, one plain sentence), thesis (the problem they solve, one sentence), strengths (3-6 short features),
proof_points (2-6 specific, checkable claims stated on the pages: prices, numbers, guarantees of service, notable facts; never invent),
pricing (as stated, or ""), offer (a no-commitment next step a prospect could get by replying "yes", e.g. "a 2-minute demo video"),
competitors (names the pages mention, or well-known direct competitors), segments (2-4 kinds of customer they sell to, each {id: snake_case, description, keywords: 4-6 words a company in that segment would use on its own website}),
roles (job titles of the buyer, most senior first).
Use only what the pages say for proof_points and pricing. Answer with the JSON object only.`;
  const user = `${instructions}\n\n${pages.join("\n\n")}`;
  let raw;
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: llmModel("write_email") || "gpt-6-luna", messages: [{ role: "user", content: user }], response_format: { type: "json_object" } }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`OpenAI said ${res.status}`);
    raw = (await res.json()).choices?.[0]?.message?.content;
  } else {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: llmModel("write_email") || "claude-sonnet-5-5", max_tokens: 4000, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`Anthropic said ${res.status}`);
    raw = (await res.json()).content?.find((c) => c.type === "text")?.text;
  }
  const json = String(raw ?? "").match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("no draft came back");
  return JSON.parse(json);
}

/** The write_email model named in config/llm.yaml (a plain text read; no YAML library needed). */
function llmModel(task) {
  const t = readFileSync(path.join(root, "config/llm.yaml"), "utf8");
  return t.match(new RegExp(`\\n  ${task}:[^\\n]*\\n\\s*- \\{[^}]*model: ([^,}\\s]+)`))?.[1] ?? "";
}

/** business.yaml as text: JSON values are valid YAML, so strings and lists are written with JSON.stringify. */
function businessYaml(d, drafted) {
  const j = (v) => JSON.stringify(v ?? "");
  const list = (a) => JSON.stringify(Array.isArray(a) ? a.filter(Boolean) : []);
  const segs = Array.isArray(d.segments) && d.segments.length ? d.segments : [{ id: "core", description: "Small US businesses that need what we sell", keywords: [] }];
  const proof = (Array.isArray(d.proof_points) ? d.proof_points : []).filter((p) => typeof p === "string" && p.trim());
  const today = new Date().toISOString().slice(0, 10);
  return `# Your business, as the agents see it. Edit here or in the dashboard (Project docs); the dashboard wins.
${drafted ? `# Drafted from your website by AI on ${today}. Review every line: emails may ONLY claim what proof_points say.\n` : ""}# Reference: config/business.example.yaml and docs/CONFIGURATION.md.
company:
  name: ${j(d.name)}
  site: ${j(d.site)}
  one_liner: ${j(d.one_liner)}
  thesis: ${j(d.thesis || d.one_liner)}
  strengths: ${list(d.strengths)}
  proof_points:           # the only specific claims emails may make about you: true, specific, checkable
${proof.length ? proof.map((p, i) => `    - {id: pp${i + 1}, text: ${j(p)}}`).join("\n") : "    []"}
  banned_claims: ["/guarantee(d)?/i"]   # never say these (plain phrases or /regex/i)
  booking_link: ${j(d.booking_link)}
  physical_address: ${j(d.physical_address)}   # REQUIRED before sending (CAN-SPAM)
  offer: ${j(d.offer || "a quick look at what we do")}
  pricing: ${j(d.pricing)}
  logo: ""                # optional PNG for the email signature, relative to this folder
  logo_dark: ""
competitors: ${list(d.competitors)}
facts: ""                 # extra facts reply drafts may use to answer questions
outreach:
  instructions: "Keep it short and specific to their business. Casual, plain tone."
  cta_reply: "yes"
  reply_cc: []
  demo_offer: "a quick call with our team"
  yes_reply: ""
  subject_lines_b: []
senders:
  - {name: ${j(d.senders?.[0]?.name)}, title: ${j(d.senders?.[0]?.title)}, reply_to: ""}
icp:
  segments:
${segs.map((s) => `    - id: ${String(s.id || "segment").toLowerCase().replace(/[^a-z0-9_]+/g, "_")}\n      description: ${j(s.description)}\n      keywords: ${list(s.keywords)}`).join("\n")}
  roles: ${list(Array.isArray(d.roles) && d.roles.length ? d.roles.map((r) => String(r).toLowerCase()) : ["owner", "founder", "ceo", "general manager"])}
  geo: [US]
  exclude_domains: []
signals: [hiring, new_office_or_launch, mentions_competitor]
`;
}
