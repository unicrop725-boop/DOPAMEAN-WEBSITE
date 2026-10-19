import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { workerHeartbeat } from '@/db/platform-schema';

export const dynamic = 'force-dynamic';

const WORKER_STALE_SECONDS = 60;

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    checks.database = { ok: true };

    const [hb] = await db
      .select({ age: sql<number>`extract(epoch from (now() - ${workerHeartbeat.beatAt}))::float` })
      .from(workerHeartbeat)
      .limit(1);
    checks.worker =
      hb && hb.age <= WORKER_STALE_SECONDS
        ? { ok: true }
        : { ok: false, detail: hb ? `last heartbeat ${Math.round(hb.age)}s ago` : 'no heartbeat' };
  } catch (err) {
    checks.database = { ok: false, detail: err instanceof Error ? err.message : 'error' };
  }
  const ok = Object.values(checks).every((c) => c.ok);
  return Response.json({ status: ok ? 'ok' : 'degraded', checks }, { status: ok ? 200 : 503 });
}
