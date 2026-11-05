import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/core/src/db/schema.ts",
  out: "./packages/core/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://gtm:gtm@localhost:5432/gtm" },
});
