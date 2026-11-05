import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// The repo keeps one .env at the root (docker-compose injects env in production).
const rootEnv = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Baked into this build's server and browser code; pages compare the two to notice a redeploy.
  env: { APP_BUILD: process.env.APP_BUILD || Date.now().toString(36) },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@opengtm/core", "@opengtm/health", "@opengtm/infra", "@opengtm/learning", "@opengtm/leads", "@opengtm/replies", "@opengtm/research", "@opengtm/sequencer", "@opengtm/verify", "@opengtm/worker", "@opengtm/writer"],
  // Node-only libraries stay external to the server bundle.
  serverExternalPackages: ["pg", "pino", "imapflow", "mailparser", "nodemailer", "pg-boss", "@electric-sql/pglite", "cheerio", "robots-parser"],
};

export default nextConfig;
