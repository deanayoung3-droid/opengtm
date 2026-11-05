import { NextResponse, type NextRequest } from "next/server";

/**
 * Who may use the dashboard: one login, DASHBOARD_USER / DASHBOARD_PASSWORD from .env (HTTP basic auth).
 * Put the dashboard behind HTTPS (see docs/DEPLOY.md) so the password never travels in the clear.
 * The signed-in user is passed on as x-gtm-user for the audit log; any incoming copy is dropped.
 * The unsubscribe links (/u/...) and health checks stay public: recipients and monitors must reach them.
 */
const appName = process.env.APP_NAME?.trim() || "OpenGTM";

const deny = (status: number, text: string, extra: Record<string, string> = {}) => new NextResponse(text, { status, headers: extra });

/** Constant-time string compare (no early exit on the first differing character). */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function proxy(request: NextRequest) {
  const forwarded = new Headers(request.headers);
  forwarded.delete("x-gtm-user");
  const pass = (who: string) => {
    forwarded.set("x-gtm-user", who);
    return NextResponse.next({ request: { headers: forwarded } });
  };

  // Local development only (next dev): DASHBOARD_AUTH=off skips the login. Never honored in production builds.
  if (process.env.NODE_ENV === "development" && process.env.DASHBOARD_AUTH === "off") return pass("local-dev");

  const user = process.env.DASHBOARD_USER || "admin";
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return deny(503, "No login is configured: set DASHBOARD_PASSWORD in .env, then restart.");
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const [u, ...rest] = atob(header.slice(6)).split(":");
    if (sameSecret(u ?? "", user) && sameSecret(rest.join(":"), password)) return pass(u!);
  }
  return deny(401, "Authentication required", { "WWW-Authenticate": `Basic realm="${appName}", charset="UTF-8"` });
}

export const config = {
  matcher: ["/((?!u/|healthz|api/health|_next/static|_next/image|favicon.ico).*)"],
};
