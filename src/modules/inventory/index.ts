import { count, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { inventoryLevel, inventoryMovement } from './schema';

type Reason = typeof inventoryMovement.$inferInsert.reason;

export type StockChange = {
  variantId: string;
  /** Positive adds stock, negative removes it. */
  delta: number;
  reason: Reason;
  actorUserId?: string;
  refType?: string;
  refId?: string;
  note?: string;
};

/** Create the stock row for a new variant with an `initial` movement. */
export async function initStock(
  tx: DbOrTx,
  variantId: string,
  onHand: number,
  actorUserId?: string,
): Promise<void> {
  if (!Number.isInteger(onHand) || onHand < 0) throw new AppError('VALIDATION_FAILED', 'onHand');
  await tx.insert(inventoryLevel).values({ variantId, onHand });
  await tx.insert(inventoryMovement).values({
    variantId,
    reason: 'initial',
    delta: onHand,
    onHandBefore: 0,
    onHandAfter: onHand,
    actorUserId,
  });
}

/**
 * Atomically change on_hand and record the movement. Never lets on_hand drop below `reserved`
 * (the conditional UPDATE matches no row), so stock cannot go negative even under concurrency (INV-03).
 */
export async function adjustStock(tx: DbOrTx, change: StockChange): Promise<{ onHand: number }> {
  if (!Number.isInteger(change.delta) || change.delta === 0) {
    throw new AppError('VALIDATION_FAILED', 'delta must be a non-zero integer');
  }
  const [row] = await tx
    .update(inventoryLevel)
    .set({
      onHand: sql`${inventoryLevel.onHand} + ${change.delta}`,
      updatedAt: sql`now()`,
    })
    .where(
      sql`${inventoryLevel.variantId} = ${change.variantId}
        AND ${inventoryLevel.onHand} + ${change.delta} >= ${inventoryLevel.reserved}`,
    )
    .returning({ onHand: inventoryLevel.onHand });
  if (!row) {
    const [exists] = await tx
      .select({ v: inventoryLevel.variantId })
      .from(inventoryLevel)
      .where(eq(inventoryLevel.variantId, change.variantId));
    throw new AppError(exists ? 'OUT_OF_STOCK' : 'NOT_FOUND');
  }
  await tx.insert(inventoryMovement).values({
    variantId: change.variantId,
    reason: change.reason,
    delta: change.delta,
    onHandBefore: row.onHand - change.delta,
    onHandAfter: row.onHand,
    actorUserId: change.actorUserId,
    refType: change.refType,
    refId: change.refId,
    note: change.note,
  });
  return { onHand: row.onHand };
}

export async function getAvailable(
  db: DbOrTx,
  variantId: string,
): Promise<{ onHand: number; reserved: number; available: number } | null> {
  const [row] = await db
    .select()
    .from(inventoryLevel)
    .where(eq(inventoryLevel.variantId, variantId));
  if (!row) return null;
  return { onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved };
}

/** Variants whose available stock is at or below their low-stock threshold. */
export async function countLowStock(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(inventoryLevel)
    .where(
      sql`${inventoryLevel.onHand} - ${inventoryLevel.reserved} <= ${inventoryLevel.lowStockThreshold}`,
    );
  return row?.n ?? 0;
}

export { availableQtySql } from './read-model';
