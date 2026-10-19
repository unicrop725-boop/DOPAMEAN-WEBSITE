import 'server-only';
import { and, eq } from 'drizzle-orm';
import { account } from '@/db/auth-schema';
import { getDb } from '@/db/client';
import { getAuth } from '@/lib/auth';

/** Re-check a user's current password (for sensitive actions such as deleting the account). */
export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ hash: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    .limit(1);
  if (!row?.hash) return false;
  const ctx = await getAuth().$context;
  return ctx.password.verify({ hash: row.hash, password });
}
