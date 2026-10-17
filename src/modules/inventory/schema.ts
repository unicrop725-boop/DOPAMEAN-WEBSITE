import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const reservationStatus = pgEnum('reservation_status', [
  'held',
  'committed',
  'released',
  'expired',
]);

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

/** Stock held for an unpaid order. Expires (default 15 min) and is released by a worker job (INV-10). */
export const reservation = pgTable(
  'reservation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Weak reference to the order that holds this stock. */
    refId: uuid('ref_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    qty: integer('qty').notNull(),
    status: reservationStatus('status').notNull().default('held'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('reservation_due_idx').on(t.status, t.expiresAt),
    index('reservation_ref_idx').on(t.refId),
    check('reservation_qty_pos', sql`${t.qty} > 0`),
  ],
);
