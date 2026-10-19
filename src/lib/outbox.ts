import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { outboxEvent } from '@/db/platform-schema';
import type { Db, DbOrTx } from '@/db/client';

export type OutboxInput = {
  aggregate: string;
  aggregateId?: string;
  type: string;
  payload: unknown;
};

/** Insert an outbox row. Call this with the same transaction handle as the business change. */
export async function enqueueOutbox(tx: DbOrTx, event: OutboxInput): Promise<string> {
  const [row] = await tx
    .insert(outboxEvent)
    .values({
      aggregate: event.aggregate,
      aggregateId: event.aggregateId,
      type: event.type,
      payload: event.payload,
    })
    .returning({ id: outboxEvent.id });
  if (!row) throw new Error('outbox insert returned no row');
  return row.id;
}

export type OutboxHandler = (payload: unknown, ctx: { id: string; log: Logger }) => Promise<void>;
export type OutboxHandlers = Record<string, OutboxHandler>;

const MAX_ATTEMPTS = 8;

/** Exponential backoff: 10s, 20s, 40s ... capped at 1h. */
export function backoffSeconds(attempts: number): number {
  return Math.min(10 * 2 ** Math.max(0, attempts - 1), 3600);
}

/**
 * Relay up to `batch` pending events. Each event is claimed with FOR UPDATE SKIP LOCKED inside its own
 * transaction, so several workers can run concurrently without double delivery.
 * Returns how many events were delivered.
 */
export async function relayOutbox(
  db: Db,
  handlers: OutboxHandlers,
  log: Logger,
  batch = 50,
): Promise<number> {
  let delivered = 0;
  for (let i = 0; i < batch; i++) {
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(outboxEvent)
        .where(and(isNull(outboxEvent.relayedAt), lte(outboxEvent.availableAt, sql`now()`)))
        .orderBy(asc(outboxEvent.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return 'empty' as const;

      const handler = handlers[row.type];
      try {
        if (!handler) throw new Error(`no handler registered for outbox type "${row.type}"`);
        await handler(row.payload, {
          id: row.id,
          log: log.child({ outboxId: row.id, type: row.type }),
        });
        await tx
          .update(outboxEvent)
          .set({ relayedAt: sql`now()` })
          .where(eq(outboxEvent.id, row.id));
        return 'delivered' as const;
      } catch (err) {
        const attempts = row.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { outboxId: row.id, type: row.type, attempts, err: message },
          'outbox delivery failed',
        );
        await tx
          .update(outboxEvent)
          .set({
            attempts,
            lastError: message,
            // After MAX_ATTEMPTS the row is pushed a day out; operators see it through lastError.
            availableAt:
              attempts >= MAX_ATTEMPTS
                ? sql`now() + interval '1 day'`
                : sql`now() + make_interval(secs => ${backoffSeconds(attempts)})`,
          })
          .where(eq(outboxEvent.id, row.id));
        return 'failed' as const;
      }
    });
    if (done === 'empty') break;
    if (done === 'delivered') delivered++;
  }
  return delivered;
}
