import { sql } from "drizzle-orm";
import { rt } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await rt().ctx.db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
