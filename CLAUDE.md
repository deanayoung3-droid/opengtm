# Notes for AI coding agents

OpenGTM is a self-hosted AI outbound email tool. Read README.md and docs/ARCHITECTURE.md first.

- Run `pnpm typecheck` and `pnpm test` before you finish; both must pass. Tests run offline.
- The user-facing product rules are in docs/ (SETUP, CONFIGURATION, RUNBOOK). Keep them true when you
  change behavior.
- Never weaken the honesty and compliance guardrails: the rule checker (`packages/writer/src/rules.ts`),
  the compliance footer, suppression checks before every send, unsubscribe handling, bounce and complaint
  circuit breakers, the kill switch, and the daily send and spend caps.
- Settings belong in `config/engine.yaml` with a schema default in `packages/core/src/config.ts`.
- Prompt changes: bump `version:` in the prompt file.
- Fixtures use made-up people and `.example` domains. Never add real personal data.
