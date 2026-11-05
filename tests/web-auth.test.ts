import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The dashboard login: DASHBOARD_USER / DASHBOARD_PASSWORD (HTTP basic auth). Unsubscribe links stay public.
async function load(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  vi.resetModules();
  return ((await import("../apps/web/proxy")) as unknown as { proxy: (r: NextRequest) => Promise<Response> }).proxy;
}
const at = (path: string, headers: Record<string, string> = {}) => new NextRequest(`https://gtm.example.com${path}`, { headers });
const basic = (u: string, p: string) => ({ authorization: `Basic ${btoa(`${u}:${p}`)}` });

describe("dashboard login", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lets in the right user and password, and records who they are", async () => {
    const proxy = await load({ DASHBOARD_USER: "sam", DASHBOARD_PASSWORD: "correct horse battery" });
    const ok = await proxy(at("/approvals", basic("sam", "correct horse battery")));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-middleware-request-x-gtm-user")).toBe("sam");
    expect((await proxy(at("/approvals", basic("sam", "wrong")))).status).toBe(401);
    expect((await proxy(at("/approvals", basic("someone", "correct horse battery")))).status).toBe(401);
    const none = await proxy(at("/approvals"));
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Basic");
  });

  it("drops a forged identity header", async () => {
    const proxy = await load({ DASHBOARD_USER: "sam", DASHBOARD_PASSWORD: "pw-long-enough" });
    const res = await proxy(at("/", { ...basic("sam", "pw-long-enough"), "x-gtm-user": "someone-else" }));
    expect(res.headers.get("x-middleware-request-x-gtm-user")).toBe("sam");
  });

  it("refuses everything until a password is set, defaulting the user to admin", async () => {
    expect((await (await load({ DASHBOARD_PASSWORD: "" }))(at("/"))).status).toBe(503);
    const proxy = await load({ DASHBOARD_USER: "", DASHBOARD_PASSWORD: "pw" });
    expect((await proxy(at("/", basic("admin", "pw")))).status).toBe(200);
  });

  it("never skips the login outside next dev", async () => {
    const proxy = await load({ NODE_ENV: "production", DASHBOARD_AUTH: "off", DASHBOARD_PASSWORD: "pw" });
    expect((await proxy(at("/"))).status).toBe(401);
  });
});
