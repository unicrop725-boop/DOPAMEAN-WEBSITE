import { and, desc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '@/db/client';
import { contactMessage, newsletterSubscriber } from '@/db/platform-schema';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/modules/audit';
import { assertCan, auditActorOf, type AdminActor } from '@/modules/staff';

const pageOf = (page?: number) => Math.max(page ?? 1, 1);
const sizeOf = (size?: number) => Math.min(Math.max(size ?? 25, 1), 100);

export type MessageStatus = 'open' | 'handled' | 'all';

/** Contact-form messages, newest first (permission customers.view). */
export async function listContactMessagesAdmin(
  db: DbOrTx,
  actor: AdminActor,
  f: { status?: MessageStatus; page?: number; pageSize?: number } = {},
) {
  assertCan(actor, 'customers.view');
  const pageSize = sizeOf(f.pageSize);
  const page = pageOf(f.page);
  const where =
    f.status === 'handled'
      ? isNotNull(contactMessage.handledAt)
      : f.status === 'all'
        ? undefined
        : isNull(contactMessage.handledAt);
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(contactMessage)
      .where(where)
      .orderBy(desc(contactMessage.createdAt), desc(contactMessage.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(contactMessage)
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

/** Mark a contact message as handled (or reopen it). Permission customers.view. Audited. */
export async function setContactMessageHandled(
  db: Db,
  actor: AdminActor,
  messageId: string,
  handled: boolean,
): Promise<void> {
  assertCan(actor, 'customers.view');
  const id = z.uuid().parse(messageId);
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(contactMessage)
      .where(eq(contactMessage.id, id))
      .for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Message not found.');
    if ((before.handledAt !== null) === handled) {
      throw new AppError(
        'VALIDATION_FAILED',
        handled ? 'Already marked as handled.' : 'Already open.',
      );
    }
    await tx
      .update(contactMessage)
      .set({ handledAt: handled ? sql`now()` : null })
      .where(eq(contactMessage.id, id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: handled ? 'contact_message.handle' : 'contact_message.reopen',
      entity: 'contact_message',
      entityId: id,
      before: { handled: before.handledAt !== null },
      after: { handled },
    });
  });
}

/** Newsletter sign-ups, newest first, optional search by name, email or phone. Read-only (customers.view). */
export async function listNewsletterSubscribersAdmin(
  db: DbOrTx,
  actor: AdminActor,
  f: { q?: string; page?: number; pageSize?: number } = {},
) {
  assertCan(actor, 'customers.view');
  const pageSize = sizeOf(f.pageSize);
  const page = pageOf(f.page);
  const conds: SQL[] = [];
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    conds.push(
      or(
        ilike(newsletterSubscriber.email, like),
        ilike(newsletterSubscriber.firstName, like),
        ilike(newsletterSubscriber.phone, like),
      ) as SQL,
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(newsletterSubscriber)
      .where(where)
      .orderBy(desc(newsletterSubscriber.createdAt), desc(newsletterSubscriber.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(newsletterSubscriber)
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
