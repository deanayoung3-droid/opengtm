# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Getting started

```bash
pnpm install
pnpm test        # everything runs offline: an in-memory Postgres, fake mailboxes, scripted AI answers
pnpm typecheck
```

To click around the dashboard locally:

```bash
pnpm dev:db                                                     # a local Postgres-compatible database on :55432
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
pnpm gtm migrate && pnpm dev:seed                               # tables and demo data
GTM_DRY_RUN=1 DASHBOARD_AUTH=off pnpm web:dev                   # http://localhost:3000
```

## Ground rules

- **Honesty is a feature.** Changes that make emails less truthful, hide who they're from, weaken
  unsubscribe handling, or get around the guardrails won't be merged.
- **Tests with behavior changes.** Add or update a test in `tests/` that would fail without your change.
- **One place for settings.** New knobs go in `config/engine.yaml` (with a comment and a schema default in
  `packages/core/src/config.ts`), not in code constants.
- **Prompts are versioned.** If you change a file in `prompts/`, bump its `version:` and update tests that
  pin it.
- **No real people in fixtures.** Use made-up names and `.example` domains.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit.
