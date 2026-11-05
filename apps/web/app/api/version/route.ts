// Which build is serving. Open pages poll this and reload after a redeploy, because a page from
// the previous build can no longer save (every build renames its server actions).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ build: process.env.APP_BUILD ?? "" }, { headers: { "cache-control": "no-store" } });
}
