import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { inventoryLevel, inventoryMovement, reservation } from './schema';

export type ReserveItem = { variantId: string; qty: number };

/**
 * Hold stock for an unpaid order (INV-03, INV-10). Each line is one atomic conditional UPDATE
 * (`reserved + qty <= on_hand`), so concurrent checkouts for the last unit cannot both win; a CHECK
 * constraint is the last line of defence. Run inside the order-placement transaction: if any line is
 * short the error aborts the whole transaction and nothing stays reserved.
 */
export async function reserveStock(
  tx: DbOrTx,
  input: { refId: string; items: ReserveItem[]; expiresAt: Date },
): Promise<void> {
  // Lock rows in a fixed order so two carts with the same items cannot deadlock.
  const items = [...input.items].sort((a, b) => a.variantId.localeCompare(b.variantId));
  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty <= 0)
      throw new AppError('VALIDATION_FAILED', 'qty');
    const [row] = await tx
      .update(inventoryLevel)
      .set({ reserved: sql`${inventoryLevel.reserved} + ${item.qty}`, updatedAt: sql`now()` })
      .where(
        sql`${inventoryLevel.variantId} = ${item.variantId}
          AND ${inventoryLevel.onHand} - ${inventoryLevel.reserved} >= ${item.qty}`,
      )
      .returning({ variantId: inventoryLevel.variantId });
    if (!row) throw new AppError('OUT_OF_STOCK', 'not enough stock', { variantId: item.variantId });
    await tx.insert(reservation).values({
      refId: input.refId,
      variantId: item.variantId,
      qty: item.qty,
      expiresAt: input.expiresAt,
    });
  }
}

type HeldRow = { id: string; variantId: string; qty: number };

/** Lock and return the still-held reservations of one order. Locking stops commit and expiry racing. */
async function lockHeld(tx: DbOrTx, refId: string): Promise<HeldRow[]> {
  return tx
    .select({ id: reservation.id, variantId: reservation.variantId, qty: reservation.qty })
    .from(reservation)
    .where(and(eq(reservation.refId, refId), eq(reservation.status, 'held')))
    .for('update');
}

async function resolve(tx: DbOrTx, ids: string[], status: 'committed' | 'released' | 'expired') {
  if (ids.length === 0) return;
  await tx
    .update(reservation)
    .set({ status, resolvedAt: sql`now()` })
    .where(inArray(reservation.id, ids));
}

/**
 * The order is paid (or COD accepted): the held stock is now sold. on_hand and reserved both drop and a
 * `sale` movement is recorded. Returns what was committed; an empty list means nothing was held any more
 * (it expired), and the caller must decide what to do (re-reserve or refund).
 */
export async function commitReservations(tx: DbOrTx, refId: string): Promise<ReserveItem[]> {
  const held = await lockHeld(tx, refId);
  for (const h of held) {
    const [row] = await tx
      .update(inventoryLevel)
      .set({
        onHand: sql`${inventoryLevel.onHand} - ${h.qty}`,
        reserved: sql`${inventoryLevel.reserved} - ${h.qty}`,
        updatedAt: sql`now()`,
      })
      .where(eq(inventoryLevel.variantId, h.variantId))
      .returning({ onHand: inventoryLevel.onHand });
    if (!row) throw new AppError('NOT_FOUND', 'inventory row missing', { variantId: h.variantId });
    await tx.insert(inventoryMovement).values({
      variantId: h.variantId,
      reason: 'sale',
      delta: -h.qty,
      onHandBefore: row.onHand + h.qty,
      onHandAfter: row.onHand,
      refType: 'order',
      refId,
    });
  }
  await resolve(
    tx,
    held.map((h) => h.id),
    'committed',
  );
  return held.map((h) => ({ variantId: h.variantId, qty: h.qty }));
}

/** Give held stock back (order cancelled or payment window ended). Safe to call twice. */
export async function releaseReservations(
  tx: DbOrTx,
  refId: string,
  status: 'released' | 'expired' = 'released',
): Promise<number> {
  const held = await lockHeld(tx, refId);
  for (const h of held) {
    await tx
      .update(inventoryLevel)
      .set({ reserved: sql`${inventoryLevel.reserved} - ${h.qty}`, updatedAt: sql`now()` })
      .where(eq(inventoryLevel.variantId, h.variantId));
  }
  await resolve(
    tx,
    held.map((h) => h.id),
    status,
  );
  return held.length;
}

/** Put sold units back on the shelf (a confirmed order is cancelled before it ships). */
export async function restockSold(
  tx: DbOrTx,
  refId: string,
  items: ReserveItem[],
  reason: 'cancellation_restock' | 'refund_restock' = 'cancellation_restock',
  actorUserId?: string,
): Promise<void> {
  for (const item of items) {
    const [row] = await tx
      .update(inventoryLevel)
      .set({ onHand: sql`${inventoryLevel.onHand} + ${item.qty}`, updatedAt: sql`now()` })
      .where(eq(inventoryLevel.variantId, item.variantId))
      .returning({ onHand: inventoryLevel.onHand });
    if (!row) continue;
    await tx.insert(inventoryMovement).values({
      variantId: item.variantId,
      reason,
      delta: item.qty,
      onHandBefore: row.onHand - item.qty,
      onHandAfter: row.onHand,
      refType: 'order',
      refId,
      actorUserId,
    });
  }
}

/**
 * Worker job: release every reservation whose time is up (INV-10). Each order is released in its own
 * transaction with row locks, so a payment that is being confirmed at the same moment either commits
 * first (and nothing is left to expire) or loses the race cleanly. Returns the order ids that expired.
 */
export async function expireDueReservations(db: Db, now: Date = new Date()): Promise<string[]> {
  const due = await db
    .selectDistinct({ refId: reservation.refId })
    .from(reservation)
    .where(and(eq(reservation.status, 'held'), lte(reservation.expiresAt, now)));
  const expired: string[] = [];
  for (const { refId } of due) {
    const n = await db.transaction((tx) => releaseReservations(tx, refId, 'expired'));
    if (n > 0) expired.push(refId);
  }
  return expired;
}

export async function listReservations(db: DbOrTx, refId: string) {
  return db.select().from(reservation).where(eq(reservation.refId, refId));
}
