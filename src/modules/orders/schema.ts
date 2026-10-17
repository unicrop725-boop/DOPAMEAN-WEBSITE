import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const orderStatus = pgEnum('order_status', [
  'pending_payment',
  'confirmed',
  'completed',
  'cancelled',
]);
export const fulfillmentStatus = pgEnum('fulfillment_status', [
  'unfulfilled',
  'shipped',
  'delivered',
]);
export const orderPaymentMethod = pgEnum('order_payment_method', ['online', 'cod']);

const paise = (name: string) => bigint(name, { mode: 'number' }).notNull();

export type OrderAddress = {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  stateCode: string;
  pincode: string;
  phone: string;
};

/** Order status and fulfilment status are separate state machines on this row; payment lives in the payments module. */
export const order = pgTable(
  'order',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Unguessable id used in URLs. */
    publicId: text('public_id').notNull(),
    /** Human-friendly sequential number shown to customers and staff. */
    number: bigint('number', { mode: 'number' })
      .notNull()
      .generatedAlwaysAsIdentity({ startWith: 1001 }),
    customerId: text('customer_id'),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    status: orderStatus('status').notNull().default('pending_payment'),
    fulfillmentStatus: fulfillmentStatus('fulfillment_status').notNull().default('unfulfilled'),
    paymentMethod: orderPaymentMethod('payment_method').notNull(),
    subtotalPaise: paise('subtotal_paise'),
    discountPaise: paise('discount_paise'),
    shippingPaise: paise('shipping_paise'),
    codFeePaise: paise('cod_fee_paise'),
    taxPaise: paise('tax_paise'),
    totalPaise: paise('total_paise'),
    shippingAddress: jsonb('shipping_address').$type<OrderAddress>().notNull(),
    /** Placing the same key twice returns the same order (INV-06). */
    idempotencyKey: text('idempotency_key').notNull(),
    /** sha256 of the secret in the confirmation link, so guests can reopen their order. */
    accessTokenHash: text('access_token_hash').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Unpaid online orders are cancelled after this time (SPEC §4.5). */
    paymentDeadlineAt: timestamp('payment_deadline_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('order_public_id_uq').on(t.publicId),
    uniqueIndex('order_number_uq').on(t.number),
    uniqueIndex('order_idempotency_uq').on(t.idempotencyKey),
    index('order_customer_idx').on(t.customerId, t.placedAt),
    index('order_status_idx').on(t.status, t.placedAt),
    check('order_total_nonneg', sql`${t.totalPaise} >= 0`),
  ],
);

/** Snapshot of what was bought (INV-07): nothing here reads the live catalog. */
export const orderLine = pgTable(
  'order_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => order.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').notNull(),
    productId: uuid('product_id').notNull(),
    productName: text('product_name').notNull(),
    optionLabel: text('option_label').notNull(),
    optionValues: jsonb('option_values').$type<Record<string, string>>().notNull(),
    sku: text('sku').notNull(),
    imageKey: text('image_key'),
    hsnCode: text('hsn_code'),
    unitPaise: paise('unit_paise'),
    qty: integer('qty').notNull(),
    discountPaise: paise('discount_paise'),
    /** Tax-inclusive total for the line after discount. */
    totalPaise: paise('total_paise'),
    taxRateBp: integer('tax_rate_bp').notNull(),
    taxPaise: paise('tax_paise'),
    cgstPaise: paise('cgst_paise'),
    sgstPaise: paise('sgst_paise'),
    igstPaise: paise('igst_paise'),
  },
  (t) => [
    index('order_line_order_idx').on(t.orderId),
    check('order_line_qty_pos', sql`${t.qty} > 0`),
  ],
);

export const orderEvent = pgTable(
  'order_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => order.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    /** A user id, or "system" / "customer" / "provider". */
    actor: text('actor').notNull(),
    payload: jsonb('payload'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('order_event_order_idx').on(t.orderId, t.at)],
);
