import "server-only";
import { buildRuntime, type Runtime } from "@opengtm/worker/context";
import { headers } from "next/headers";

const g = globalThis as unknown as { __gtmRuntime?: Runtime };

/** One DB pool and runtime per server process (survives dev hot reloads). */
export function rt(): Runtime {
  // Rebuild if a dev hot reload left a runtime from older code behind.
  if (!g.__gtmRuntime?.refreshConfig) g.__gtmRuntime = buildRuntime(process.env, "web");
  return g.__gtmRuntime;
}

/** Runtime with the latest project docs applied (call once per request before reading ctx.config). */
export async function rtReady(): Promise<Runtime> {
  const r = rt();
  await r.refreshConfig();
  return r;
}

/** The signed-in dashboard user (DASHBOARD_USER), set by proxy.ts. */
export async function identity(): Promise<string> {
  return (await headers()).get("x-gtm-user") ?? "unknown";
}

/** Who is acting, for the audit log. */
export async function actor(): Promise<string> {
  return `web:${await identity()}`;
}
