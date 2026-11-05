# The whole app in one container: database migrations, the dashboard (Next.js) and the background worker.
# Listens on 8080; GET /healthz answers without login; runs as non-root; no secrets at build time.
# Settings (API keys, mailbox credentials) come from environment variables (.env with docker compose,
# or your hosting platform's settings). See docs/DEPLOY.md.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @opengtm/web build && node scripts/bundle-worker.mjs

FROM base AS runtime
ENV NODE_ENV=production PORT=8080 TZ=America/Los_Angeles NODE_OPTIONS=--max-old-space-size=192
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# -g: signals reach the whole process group (worker + dashboard) so shutdowns are clean.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
# Worker + dashboard, pre-compiled. Admin commands: `node dist/cli.mjs <command>` (e.g. kill on, migrate).
CMD ["node", "dist/start.mjs"]
