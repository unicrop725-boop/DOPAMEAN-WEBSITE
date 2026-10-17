import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A cart belongs to a signed-in customer OR to an anonymous browser (token hash). Prices are never stored
 * on cart lines: they are read from the catalog every time (INV-01, INV-12).
 */
export const cart = pgTable(
  'cart',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: text('customer_id'),
    /** sha256 of the random token kept in the browser cookie. */
    anonTokenHash: text('anon_token_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cart_customer_uq').on(t.customerId),
    uniqueIndex('cart_anon_uq').on(t.anonTokenHash),
    check('cart_has_owner', sql`${t.customerId} IS NOT NULL OR ${t.anonTokenHash} IS NOT NULL`),
  ],
);

export const cartLine = pgTable(
  'cart_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => cart.id, { onDelete: 'cascade' }),
    /** Weak reference to catalog.variant. */
    variantId: uuid('variant_id').notNull(),
    qty: integer('qty').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cart_line_variant_uq').on(t.cartId, t.variantId),
    index('cart_line_cart_idx').on(t.cartId),
    check('cart_line_qty_range', sql`${t.qty} > 0 AND ${t.qty} <= 10`),
  ],
);
