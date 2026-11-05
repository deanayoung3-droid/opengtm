/**
 * One-container entrypoint (the Dockerfile runs this; port 8080 by default):
 *   1. wait for Postgres (it can come up ~30s after the app on first deploy) and apply migrations
 *   2. start the dashboard (Next.js) as a child process on PORT
 *   3. run the worker in this process
 * If either half dies the container exits, and the platform restarts it.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { createLogger, findRepoRoot, runMigrations } from "@opengtm/core";

const log = createLogger("start");
const url = process.env.DATABASE_URL;
if (!url) {
  log.fatal("DATABASE_URL is not set (on the platform: add the empty file platform/postgres and push)");
  process.exit(1);
}

for (let attempt = 1; ; attempt++) {
  try {
    await runMigrations(url);
    log.info("migrations applied");
    break;
  } catch (err) {
    if (attempt >= 40) {
      log.fatal({ err: (err as Error).message }, "database still unreachable after 40 tries; giving up");
      process.exit(1);
    }
    log.warn({ attempt, err: (err as Error).message }, "database not ready; retrying in 5s");
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const webDir = path.join(findRepoRoot(), "apps", "web");
const nextBin = createRequire(path.join(webDir, "package.json")).resolve("next/dist/bin/next");
const web = spawn(process.execPath, [nextBin, "start", "-p", process.env.PORT ?? "8080", "-H", "0.0.0.0"], {
  cwd: webDir,
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: process.env.WEB_NODE_OPTIONS ?? "--max-old-space-size=224" },
});
web.on("exit", (code, signal) => {
  log.fatal({ code, signal }, "dashboard exited; stopping the container so it restarts");
  process.exit(code || 1);
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => web.kill(sig));

await import("./index");
