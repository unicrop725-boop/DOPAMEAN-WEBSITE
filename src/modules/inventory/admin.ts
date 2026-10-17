import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/modules/audit';
import { assertCan, auditActorOf, type AdminActor } from '@/modules/staff';
import { adjustStock } from './stock';
import { inventoryLevel, inventoryMovement } from './schema';

const adjustInput = z.object({
  variantId: z.uuid(),
  /** Positive adds stock, negative removes it. Never zero. */
  delta: z
    .number()
    .int('Enter a whole number of units')
    .min(-100_000)
    .max(100_000)
    .refine((n) => n !== 0, 'Enter a change other than zero'),
  reason: z.enum(['adjustment', 'correction']).default('adjustment'),
  note: z.string().trim().min(3, 'Say why the stock is changing').max(300),
});
export type AdjustStockInput = z.input<typeof adjustInput>;

/**
 * Staff stock adjustment (permission inventory.edit). Writes the movement and an audit event with the
 * on-hand before and after in one transaction. It can never take on-hand below what is reserved for
 * unpaid orders (SPEC 4.4).
 */
export async function adjustStockAdmin(
  db: Db,
  actor: AdminActor,
  rawInput: AdjustStockInput,
): Promise<{ onHand: number; reserved: number; available: number }> {
  assertCan(actor, 'inventory.edit');
  const input = adjustInput.parse(rawInput);
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(inventoryLevel)
      .where(eq(inventoryLevel.variantId, input.variantId))
      .for('update');
    if (!before) throw new AppError('NOT_FOUND', 'That variant has no stock record.');
    try {
      await adjustStock(tx, {
        variantId: input.variantId,
        delta: input.delta,
        reason: input.reason,
        actorUserId: actor.userId,
        note: input.note,
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'OUT_OF_STOCK') {
        throw new AppError(
          'OUT_OF_STOCK',
          `On hand cannot go below the ${before.reserved} unit(s) currently reserved for unpaid orders.`,
          { reserved: before.reserved },
        );
      }
      throw err;
    }
    const onHand = before.onHand + input.delta;
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'inventory.adjust',
      entity: 'variant',
      entityId: input.variantId,
      before: { onHand: before.onHand },
      after: { onHand, delta: input.delta, reason: input.reason, note: input.note },
    });
    return { onHand, reserved: before.reserved, available: onHand - before.reserved };
  });
}

const thresholdInput = z.object({
  variantId: z.uuid(),
  threshold: z.number().int('Enter a whole number').min(0).max(100_000),
});

/** Change the low-stock alert threshold for one variant (permission inventory.edit). */
export async function setLowStockThresholdAdmin(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof thresholdInput>,
): Promise<void> {
  assertCan(actor, 'inventory.edit');
  const input = thresholdInput.parse(rawInput);
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(inventoryLevel)
      .where(eq(inventoryLevel.variantId, input.variantId))
      .for('update');
    if (!before) throw new AppError('NOT_FOUND', 'That variant has no stock record.');
    await tx
      .update(inventoryLevel)
      .set({ lowStockThreshold: input.threshold })
      .where(eq(inventoryLevel.variantId, input.variantId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'inventory.set_threshold',
      entity: 'variant',
      entityId: input.variantId,
      before: { lowStockThreshold: before.lowStockThreshold },
      after: { lowStockThreshold: input.threshold },
    });
  });
}

/** Movement history of one variant, newest first, paginated (permission inventory.edit). */
export async function listMovementsAdmin(
  db: DbOrTx,
  actor: AdminActor,
  variantId: string,
  opts: { page?: number; pageSize?: number } = {},
) {
  assertCan(actor, 'inventory.edit');
  const id = z.uuid().parse(variantId);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, id))
      .orderBy(desc(inventoryMovement.createdAt), desc(inventoryMovement.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, id)),
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
