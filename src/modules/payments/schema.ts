import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'captured',
  'failed',
  'partially_refunded',
  'refunded',
  'needs_review',
]);
export const paymentMethod = pgEnum('payment_method', ['online', 'cod']);
export const attemptStatus = pgEnum('payment_attempt_status', [
  'created',
  'captured',
  'failed',
  'expired',
]);
export const refundStatus = pgEnum('refund_status', ['requested', 'succeeded', 'failed']);

const paise = (name: string) => bigint(name, { mode: 'number' }).notNull();

export const payment = pgTable(
  'payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Weak reference to orders.order (one payment per order). */
    orderId: uuid('order_id').notNull(),
    method: paymentMethod('method').notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    amountPaise: paise('amount_paise'),
    capturedPaise: paise('captured_paise').default(0),
    refundedPaise: paise('refunded_paise').default(0),
    provider: text('provider'),
    providerOrderId: text('provider_order_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('payment_order_uq').on(t.orderId),
    uniqueIndex('payment_provider_order_uq').on(t.providerOrderId),
    // INV-09 at the database level: you can never refund more than was captured.
    check('payment_refunded_le_captured', sql`${t.refundedPaise} <= ${t.capturedPaise}`),
    check('payment_captured_le_amount', sql`${t.capturedPaise} <= ${t.amountPaise}`),
    check(
      'payment_amounts_nonneg',
      sql`${t.capturedPaise} >= 0 AND ${t.refundedPaise} >= 0 AND ${t.amountPaise} >= 0`,
    ),
  ],
);

export const paymentAttempt = pgTable(
  'payment_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payment.id, { onDelete: 'cascade' }),
    providerOrderId: text('provider_order_id').notNull(),
    providerPaymentId: text('provider_payment_id'),
    status: attemptStatus('status').notNull().default('created'),
    amountPaise: paise('amount_paise'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_attempt_payment_idx').on(t.paymentId),
    index('payment_attempt_status_idx').on(t.status, t.createdAt),
  ],
);

/** Every provider notification, stored raw. The unique key makes redelivery a no-op (INV-04). */
export const webhookEvent = pgTable(
  'webhook_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    rawBody: text('raw_body').notNull(),
    signatureOk: boolean('signature_ok').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [uniqueIndex('webhook_provider_event_uq').on(t.provider, t.providerEventId)],
);

export const refund = pgTable(
  'refund',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payment.id, { onDelete: 'cascade' }),
    amountPaise: paise('amount_paise'),
    status: refundStatus('status').notNull().default('requested'),
    /** Sent to the provider so a retry can never refund twice. */
    idempotencyKey: text('idempotency_key').notNull(),
    providerRefundId: text('provider_refund_id'),
    reason: text('reason'),
    createdBy: text('created_by'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('refund_idempotency_uq').on(t.idempotencyKey),
    index('refund_payment_idx').on(t.paymentId),
    check('refund_amount_pos', sql`${t.amountPaise} > 0`),
  ],
);
