// Platform health check: answers fast with no login and no database (the platform's rule).
export const dynamic = "force-dynamic";

export function GET() {
  return new Response("ok\n", { headers: { "content-type": "text/plain" } });
}
