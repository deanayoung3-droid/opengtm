import { createServer } from "node:http";
import { DAY, humanTodos, sendingBlockers, TEAM_TZ } from "@opengtm/core";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { buildRuntime } from "./context";
import { buildJobs } from "./jobs";

const rt = buildRuntime();
const { ctx } = rt;
const log = ctx.log;

// Project docs (edited in the dashboard) override config/business.yaml, so check the merged config.
await rt.refreshConfig().catch((err) => log.warn({ err: (err as Error).message }, "could not load project docs yet"));
for (const t of humanTodos(ctx.config)) log.warn({ field: t.field, blocksSending: t.blocksSending }, `HUMAN: ${t.note}`);
if (sendingBlockers(ctx.config).length) log.warn("sending is blocked until these are filled in on Project docs");
if (rt.dryRun) log.warn("GTM_DRY_RUN=1: fake transports, mock verifier and mock lead vendor");

const boss = new PgBoss(process.env.DATABASE_URL!);
boss.on("error", (err) => log.error({ err }, "pg-boss error"));
await boss.start();

const jobs = buildJobs(rt);
const lastOk = new Map<string, number>();
const failures = new Map<string, number>();

for (const [name, job] of Object.entries(jobs)) {
  // singleton: never two runs of the same stage at once; queues live in Postgres so restarts lose nothing.
  await boss.createQueue(name, { policy: "singleton" }).catch(() => undefined);
  // Queues created before a job had a longer limit keep the old one unless updated.
  if (job.expireInSeconds) await boss.updateQueue(name, { expireInSeconds: job.expireInSeconds }).catch((err) => log.warn({ err, job: name }, "could not set job time limit"));
  await boss.schedule(name, job.cron, null, { tz: TEAM_TZ });
  await boss.work(name, { pollingIntervalSeconds: 5 }, async () => {
    const started = Date.now();
    try {
      await rt.refreshConfig();
      const result = await job.run();
      lastOk.set(name, Date.now());
      failures.set(name, 0);
      log.debug({ job: name, ms: Date.now() - started, result }, "job done");
    } catch (err) {
      const n = (failures.get(name) ?? 0) + 1;
      failures.set(name, n);
      log.error({ err, job: name, consecutiveFailures: n }, "job failed");
      // One email per broken job per day: jobs that run every minute would otherwise repeat it every hour.
      if (n >= 3) await ctx.alerts.notify({ level: "critical", key: `job_failing:${name}`, quietMs: DAY, title: `Worker job failing: ${name}`, body: `${n} consecutive failures. Last error: ${(err as Error).message.slice(0, 600)}` });
      throw err;
    }
  });
}
log.info({ jobs: Object.keys(jobs) }, "worker started");

// Healthcheck for docker: DB reachable and the send loop ran recently.
const server = createServer(async (req, res) => {
  if (req.url !== "/healthz") {
    res.writeHead(404).end();
    return;
  }
  try {
    await ctx.db.execute(sql`select 1`);
    const sendAge = Date.now() - (lastOk.get("send") ?? Date.now());
    const ok = sendAge < 10 * 60_000;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok, sendAgeMs: sendAge, lastOk: Object.fromEntries(lastOk) }));
  } catch (err) {
    res.writeHead(503).end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
});
server.listen(Number(process.env.WORKER_HEALTH_PORT ?? 8081), "0.0.0.0");

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  server.close();
  await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
  await rt.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
