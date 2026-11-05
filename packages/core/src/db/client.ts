import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { findRepoRoot } from "../config";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Works for both node-postgres (prod) and PGlite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

/** Resolved at call time so bundlers (Next/Turbopack) don't try to package the folder. */
export function migrationsDir(): string {
  return process.env.GTM_MIGRATIONS_DIR ?? path.join(findRepoRoot(), "packages", "core", "migrations");
}

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, close: () => pool.end() };
}

export async function runMigrations(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: migrationsDir() });
  } finally {
    await pool.end();
  }
}
