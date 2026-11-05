# Architecture

A pnpm monorepo in TypeScript. One Postgres database holds everything, including the job queue
(pg-boss), so there's no Redis or other moving part.

```
apps/web            Next.js dashboard, server actions, unsubscribe pages, health checks
apps/worker         pg-boss worker: every pipeline stage as a scheduled job; the admin CLI
packages/core       database schema (Drizzle), config loading and validation, LLM router, alerts, shared helpers
packages/leads      lead sources (AI Ark, CSV, company websites, a mock), discovery, fit scoring
packages/verify     email verification (ZeroBounce, Reacher, MX checks, mock)
packages/research   polite website fetching, fact extraction with source URLs, signals
packages/writer     the writer, rule checker, AI critic, compliance footer, approval policy, signatures
packages/sequencer  mailboxes, transports (Gmail API, Microsoft Graph, SMTP/IMAP), ramp, scheduling, sending, reply/bounce ingest
packages/replies    reply classification, automatic actions, drafted answers, hot-lead briefs, CRM sink
packages/learning   per-campaign and per-variant metrics, A/B decisions, the weekly digest
packages/health     bounce/complaint circuit breakers, seed placement tests, spend alerts
packages/infra      DNS checks for sending domains
prompts/            the instructions for each AI job (versioned)
config/             business.yaml (yours), engine.yaml, llm.yaml
```

## The pipeline

Each stage is a job (see `JOB_PLAN` in `apps/worker/src/jobs.ts`; the Schedule page lists them). Jobs are
idempotent and retried, so a crash or restart never sends twice.

1. **discover**: asks each lead source for companies and people matching a campaign, buying only what the
   mailboxes can email in the next few days. Deduplicated by domain and email; suppressed ones skipped.
2. **qualify**: a 0-100 fit score (geography, size, keyword match, signals); an AI tagger helps when
   keywords don't decide. Poor fits are dropped with the reason.
3. **verify**: suppression, syntax, MX, then the verifier. Only `valid` addresses go on.
4. **research**: fetches a few pages of the company's site (respecting robots.txt), extracts atomic facts
   with source URLs, and keeps only facts whose words actually appear on the cited page.
5. **enroll**: one person per company per campaign, the decision maker first.
6. **write**: drafts the sequence from facts and proof points, then the rule checker, AI critic and
   compliance check. A flagged draft is rewritten once with the reasons; still flagged, it waits on Approvals.
7. **schedule / send**: each email goes in the recipient's business hours, on the mailbox that owns the
   thread, within the mailbox's ramp and the daily caps. A message row is locked before the SMTP call, so
   a crash mid-send is reported, never repeated.
8. **ingest / replies**: reads every mailbox, matches replies and bounces by headers, classifies replies,
   takes the action for each label (stop, suppress, snooze, add a referral...) and drafts answers.
9. **health / learning / digest**: guardrails, A/B decisions and the weekly report.

## Data model

`packages/core/src/db/schema.ts`. The main tables: `companies`, `contacts`, `facts` (each with a source
URL), `segments` and `campaigns`, `sequences` and `sequence_steps` (variants A/B), `threads` and
`messages` (with prompt version, model, cost, the facts and proof points cited, and the QA verdict),
`replies`, `meetings` (hot leads), `mailboxes` and `domains`, `suppression` (forever), `events`
(append-only), `llm_calls` and `spend_ledger` (every cost), `settings`, `team_members` and `audit_log`.

Migrations are generated with `pnpm db:generate` from the schema and applied on start.

## AI calls

Everything goes through one router (`packages/core/src/llm/router.ts`): `llm.run(task, input, schema)`.
`config/llm.yaml` maps each task to a provider and model with fallbacks; outputs are validated against a
zod schema; every call is logged with its cost; per-lead and daily spend caps are enforced in code.
Providers: OpenAI, Anthropic, Gemini, and any OpenAI-compatible server.

## Swapping parts

Every outside service sits behind an interface: `LeadSource`, `Verifier`, `MailTransport`, `LLMProvider`,
`CRMSink`, `AlertSink`. Adding a lead source is one class implementing `LeadSource`
(`packages/leads/src/types.ts`), wired in `apps/worker/src/jobs.ts`.

## Tests

`pnpm test` runs ~180 tests against a real Postgres running in memory (PGlite), with fake transports, a
fake clock and scripted AI answers (`packages/core/src/testing.ts`), including multi-day sending
simulations. No network or API keys needed.
