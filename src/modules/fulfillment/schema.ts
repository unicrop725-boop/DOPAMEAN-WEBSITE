import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const shipment = pgTable(
  'shipment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Weak reference to orders.order. */
    orderId: uuid('order_id').notNull(),
    carrier: text('carrier').notNull(),
    trackingNo: text('tracking_no').notNull(),
    trackingUrl: text('tracking_url'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdBy: text('created_by'),
  },
  (t) => [index('shipment_order_idx').on(t.orderId)],
);
