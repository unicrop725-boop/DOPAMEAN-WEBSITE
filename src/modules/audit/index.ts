import { and, desc, eq } from 'drizzle-orm';
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
