import { and, desc, eq, gte, ilike, lt, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { auditEvent } from './schema';

export type AuditActor = {
  userId: string;
  role: 'owner' | 'manager' | 'support';
  ip?: string | null;
  userAgent?: string | null;
};

export type AuditInput = {
  actor: AuditActor;
  /** Verb-noun, e.g. "product.update", "order.refund". */
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
};

/**
 * Record a privileged action (INV-14). Pass the same transaction handle as the change itself so the
 * audit row commits or rolls back with it.
 */
export async function recordAudit(tx: DbOrTx, input: AuditInput): Promise<void> {
  await tx.insert(auditEvent).values({
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    ip: input.actor.ip ?? null,
    userAgent: input.actor.userAgent ?? null,
  });
}

export type AuditSearch = {
  entity?: string;
  entityId?: string;
  actorUserId?: string;
  /** Matches the start of the action name, so "order." finds every order action. */
  action?: string;
  from?: Date;
  /** Exclusive upper bound. */
  to?: Date;
  page?: number;
  pageSize?: number;
};

export type AuditRow = typeof auditEvent.$inferSelect;

/** Filtered, paginated audit search (page size capped at 100). Read-only: the table is append-only. */
export async function searchAudit(db: DbOrTx, f: AuditSearch = {}) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const conds: SQL[] = [];
  if (f.entity) conds.push(eq(auditEvent.entity, f.entity));
  if (f.entityId) conds.push(eq(auditEvent.entityId, f.entityId));
  if (f.actorUserId) conds.push(eq(auditEvent.actorUserId, f.actorUserId));
  if (f.action) {
    conds.push(ilike(auditEvent.action, `${f.action.replace(/[%_\\]/g, '\\$&')}%`));
  }
  if (f.from) conds.push(gte(auditEvent.at, f.from));
  if (f.to) conds.push(lt(auditEvent.at, f.to));
  const where = conds.length ? and(...conds) : undefined;
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(auditEvent)
      .where(where)
      .orderBy(desc(auditEvent.at), desc(auditEvent.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEvent)
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

/** Distinct entity types and actions seen so far, for filter pickers. */
export async function auditFilterOptions(
  db: DbOrTx,
): Promise<{ entities: string[]; actions: string[] }> {
  const [entities, actions] = await Promise.all([
    db.selectDistinct({ v: auditEvent.entity }).from(auditEvent).orderBy(auditEvent.entity),
    db.selectDistinct({ v: auditEvent.action }).from(auditEvent).orderBy(auditEvent.action),
  ]);
  return { entities: entities.map((r) => r.v), actions: actions.map((r) => r.v) };
}

export async function listAudit(
  db: DbOrTx,
  filter: { entity?: string; entityId?: string; limit?: number } = {},
) {
  const limit = Math.min(filter.limit ?? 50, 100);
  const conditions = [
    filter.entity ? eq(auditEvent.entity, filter.entity) : undefined,
    filter.entityId ? eq(auditEvent.entityId, filter.entityId) : undefined,
  ].filter((c) => c !== undefined);
  return db
    .select()
    .from(auditEvent)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditEvent.at))
    .limit(limit);
}
