import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '@/db/client';
import { user } from '@/db/auth-schema';
import { assertCan, type AdminActor } from '@/modules/staff';
import { address, customerProfile } from './schema';

export type AdminCustomerFilter = { q?: string; page?: number; pageSize?: number };

/** Customer accounts (not staff, not guests) with search by name, email or phone. Permission customers.view. */
export async function listCustomersAdmin(
  db: DbOrTx,
  actor: AdminActor,
  f: AdminCustomerFilter = {},
) {
  assertCan(actor, 'customers.view');
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const conds: SQL[] = [];
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    conds.push(
      or(
        ilike(user.name, like),
        ilike(user.email, like),
        ilike(customerProfile.phone, like),
      ) as SQL,
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  const base = db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      phone: customerProfile.phone,
      createdAt: user.createdAt,
      deleted: sql<boolean>`${customerProfile.deletedAt} IS NOT NULL`,
    })
    .from(customerProfile)
    .innerJoin(user, eq(user.id, customerProfile.userId))
    .where(where);
  const [items, [total]] = await Promise.all([
    base
      .orderBy(desc(user.createdAt), desc(user.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(customerProfile)
      .innerJoin(user, eq(user.id, customerProfile.userId))
      .where(where),
  ]);
  const count = total?.n ?? 0;
  return {
    items,
    total: count,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(count / pageSize)),
  };
}

/** One customer's account, profile and addresses, or null. Permission customers.view. */
export async function getCustomerAdmin(db: DbOrTx, actor: AdminActor, userId: string) {
  assertCan(actor, 'customers.view');
  if (!z.string().min(1).max(100).safeParse(userId).success) return null;
  const [row] = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      phone: customerProfile.phone,
      marketingOptIn: customerProfile.marketingOptIn,
      deletedAt: customerProfile.deletedAt,
    })
    .from(customerProfile)
    .innerJoin(user, eq(user.id, customerProfile.userId))
    .where(eq(customerProfile.userId, userId));
  if (!row) return null;
  const addresses = await db
    .select()
    .from(address)
    .where(eq(address.customerId, userId))
    .orderBy(desc(address.isDefault), desc(address.createdAt));
  return { ...row, addresses };
}
