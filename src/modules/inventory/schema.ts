import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const movementReason = pgEnum('inventory_movement_reason', [
  'initial',
  'adjustment',
  'sale',
  'reservation_release',
  'cancellation_restock',
  'refund_restock',
  'correction',
]);

/** One row per variant. `variant_id` is a weak reference to catalog.variant (no cross-module FK). */
export const inventoryLevel = pgTable(
  'inventory_level',
  {
    variantId: uuid('variant_id').primaryKey(),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Last line of defence for INV-03: stock can never go negative, reservations never exceed stock.
    check('inventory_on_hand_nonneg', sql`${t.onHand} >= 0`),
    check('inventory_reserved_nonneg', sql`${t.reserved} >= 0`),
    check('inventory_reserved_le_on_hand', sql`${t.reserved} <= ${t.onHand}`),
  ],
);

export const inventoryMovement = pgTable(
  'inventory_movement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variantId: uuid('variant_id').notNull(),
    reason: movementReason('reason').notNull(),
    /** Change to on_hand (negative for sales). Reservation moves are recorded with reason reservation_release. */
    delta: integer('delta').notNull(),
    onHandBefore: integer('on_hand_before').notNull(),
    onHandAfter: integer('on_hand_after').notNull(),
    actorUserId: text('actor_user_id'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('inventory_movement_variant_idx').on(t.variantId, t.createdAt)],
);
