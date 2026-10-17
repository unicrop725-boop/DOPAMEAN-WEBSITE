import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { assertCan, type AdminActor } from '@/modules/staff';
import { order, orderLine } from './schema';

/**
 * Read models for the admin: sales report, dashboard numbers, and a few lookups the catalog admin needs.
 *
 * Boundary note: refunds and COD collection state live in the payments module, which exposes no range or
 * aggregate query. These read-only reports therefore query the `refund` and `payment` tables with SQL
 * directly. If payments gains `sumSucceededRefunds(range)` and `listUncollectedCodOrderIds()`, switch to them.
 *
 * Time zone: the store trades in India, so "a day" is a calendar day in Asia/Kolkata (UTC+05:30, no DST).
 */
const IST_OFFSET = '+05:30';
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

export const LIVE_STATUSES = ['confirmed', 'completed'] as const;

/** Written definitions shown next to every number in the admin (brief section 8.3). */
export const REPORT_DEFINITIONS = {
  grossSales:
    'Gross sales: sum of order totals (tax and shipping included, after discounts) for orders placed in the range whose status is confirmed or completed. Cancelled orders and unpaid online orders are not counted.',
  orders: 'Orders: how many orders make up gross sales.',
  refunds:
    'Refunds: sum of refunds that succeeded in the range, on orders that count in gross sales (confirmed or completed). Counted when the refund succeeded, not when the order was placed.',
  cancelledRefunds:
    'Refunds on cancelled orders (information only): those orders are not in gross sales, so these refunds are not deducted from net sales.',
  netSales: 'Net sales: gross sales minus refunds.',
  averageOrderValue:
    'Average order value: gross sales divided by the number of orders, rounded to the nearest paisa (0 when there are no orders).',
  taxCollected:
    'Tax collected: sum of GST included in those orders (CGST + SGST + IGST). It is part of gross sales, not on top of it, and is not reduced by refunds.',
  split:
    'Online versus cash on delivery: gross sales and order count of those orders by the payment method chosen at checkout.',
} as const;

export const DASHBOARD_DEFINITIONS = {
  ordersByStatus: 'Orders by status: every order ever placed, grouped by its current status.',
  ordersToday:
    'Orders today: orders placed since midnight (India time) that are confirmed or completed.',
  awaitingShipment: 'Awaiting shipment: confirmed orders that have not been marked shipped yet.',
  awaitingCod:
    'Awaiting COD collection: cash-on-delivery orders that are confirmed or completed and whose cash has not been marked collected.',
  lowStock:
    'Low-stock variants: active variants of products that are not archived whose available units (on hand minus reserved) are at or below their threshold.',
  salesThisMonth:
    'Sales this month: gross sales (as defined on the Reports page) from the 1st of this month, India time, until now.',
} as const;

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'Not a real calendar date');

const rangeInput = z.object({ from: dateOnly, to: dateOnly });
export type SalesRange = z.input<typeof rangeInput>;

/** Midnight (India time) at the start of a YYYY-MM-DD day, as an instant. */
export function istStartOf(day: string): Date {
  return new Date(`${day}T00:00:00${IST_OFFSET}`);
}

/** The YYYY-MM-DD calendar day (India time) that an instant falls on. */
export function istDayOf(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** First day of the month containing `at`, India time. */
export function istMonthStart(at: Date): string {
  return `${istDayOf(at).slice(0, 8)}01`;
}

export type SalesReport = {
  range: { from: string; to: string };
  grossSalesPaise: number;
  orderCount: number;
  refundsPaise: number;
  cancelledRefundsPaise: number;
  netSalesPaise: number;
  averageOrderValuePaise: number;
  taxCollectedPaise: number;
  split: Record<'online' | 'cod', { orderCount: number; grossSalesPaise: number }>;
};

/** Integer average, rounded half up. */
function averagePaise(totalPaise: number, count: number): number {
  return count === 0 ? 0 : Math.floor((totalPaise * 2 + count) / (count * 2));
}

/** Sales report for an inclusive range of days (permission reports.view). Ranges are capped at 366 days. */
export async function salesReport(
  db: DbOrTx,
  actor: AdminActor,
  rawRange: SalesRange,
): Promise<SalesReport> {
  assertCan(actor, 'reports.view');
  const parsed = rangeInput.safeParse(rawRange);
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_FAILED',
      parsed.error.issues[0]?.message ?? 'Invalid date range',
    );
  }
  const { from, to } = parsed.data;
  const start = istStartOf(from);
  const endExclusive = new Date(istStartOf(to).getTime() + DAY_MS);
  if (endExclusive.getTime() <= start.getTime()) {
    throw new AppError('VALIDATION_FAILED', 'The end date must not be before the start date.');
  }
  if ((endExclusive.getTime() - start.getTime()) / DAY_MS > MAX_RANGE_DAYS) {
    throw new AppError('VALIDATION_FAILED', `Pick a range of at most ${MAX_RANGE_DAYS} days.`);
  }

  const live = and(
    inArray(order.status, [...LIVE_STATUSES]),
    gte(order.placedAt, start),
    lt(order.placedAt, endExclusive),
  );
  const byMethod = await db
    .select({
      method: order.paymentMethod,
      n: sql<number>`count(*)::int`,
      gross: sql<string>`COALESCE(SUM(${order.totalPaise}), 0)::bigint`,
      tax: sql<string>`COALESCE(SUM(${order.taxPaise}), 0)::bigint`,
    })
    .from(order)
    .where(live)
    .groupBy(order.paymentMethod);

  const split: SalesReport['split'] = {
    online: { orderCount: 0, grossSalesPaise: 0 },
    cod: { orderCount: 0, grossSalesPaise: 0 },
  };
  let gross = 0;
  let count = 0;
  let tax = 0;
  for (const r of byMethod) {
    split[r.method] = { orderCount: r.n, grossSalesPaise: Number(r.gross) };
    gross += Number(r.gross);
    count += r.n;
    tax += Number(r.tax);
  }

  const refundRes = await db.execute<{ live: string; cancelled: string }>(sql`
    SELECT
      COALESCE(SUM(r.amount_paise) FILTER (WHERE o.status IN ('confirmed', 'completed')), 0)::bigint AS live,
      COALESCE(SUM(r.amount_paise) FILTER (WHERE o.status = 'cancelled'), 0)::bigint AS cancelled
    FROM refund r
    JOIN payment p ON p.id = r.payment_id
    JOIN "order" o ON o.id = p.order_id
    WHERE r.status = 'succeeded' AND r.updated_at >= ${start} AND r.updated_at < ${endExclusive}`);
  const refunds = Number(refundRes.rows[0]?.live ?? 0);
  const cancelledRefunds = Number(refundRes.rows[0]?.cancelled ?? 0);

  return {
    range: { from, to },
    grossSalesPaise: gross,
    orderCount: count,
    refundsPaise: refunds,
    cancelledRefundsPaise: cancelledRefunds,
    netSalesPaise: gross - refunds,
    averageOrderValuePaise: averagePaise(gross, count),
    taxCollectedPaise: tax,
    split,
  };
}

export type DashboardMetrics = {
  ordersByStatus: Record<'pending_payment' | 'confirmed' | 'completed' | 'cancelled', number>;
  ordersToday: number;
  awaitingShipment: number;
  awaitingCodCollection: number;
};

/** Order counts for the dashboard (permission orders.view). */
export async function dashboardMetrics(
  db: DbOrTx,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<DashboardMetrics> {
  assertCan(actor, 'orders.view');
  const todayStart = istStartOf(istDayOf(now));
  const [statusRows, today, shipping, cod] = await Promise.all([
    db
      .select({ status: order.status, n: sql<number>`count(*)::int` })
      .from(order)
      .groupBy(order.status),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(order)
      .where(and(inArray(order.status, [...LIVE_STATUSES]), gte(order.placedAt, todayStart))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(order)
      .where(and(eq(order.status, 'confirmed'), eq(order.fulfillmentStatus, 'unfulfilled'))),
    db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM "order" o
      WHERE o.payment_method = 'cod' AND o.status IN ('confirmed', 'completed')
        AND EXISTS (SELECT 1 FROM payment p WHERE p.order_id = o.id AND p.status = 'pending')`),
  ]);
  const ordersByStatus = { pending_payment: 0, confirmed: 0, completed: 0, cancelled: 0 };
  for (const r of statusRows) ordersByStatus[r.status] = r.n;
  return {
    ordersByStatus,
    ordersToday: today[0]?.n ?? 0,
    awaitingShipment: shipping[0]?.n ?? 0,
    awaitingCodCollection: cod.rows[0]?.n ?? 0,
  };
}

/** Units per order (sum of line quantities) for a page of orders. */
export async function countOrderItems(
  db: DbOrTx,
  orderIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  const rows = await db
    .select({ orderId: orderLine.orderId, n: sql<number>`COALESCE(SUM(${orderLine.qty}), 0)::int` })
    .from(orderLine)
    .where(inArray(orderLine.orderId, orderIds))
    .groupBy(orderLine.orderId);
  for (const r of rows) out.set(r.orderId, r.n);
  return out;
}

/** Whether any order line ever referenced this product (decides soft versus hard delete). */
export async function productEverOrdered(db: DbOrTx, productId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orderLine)
    .where(eq(orderLine.productId, productId))
    .limit(1);
  return (row?.n ?? 0) > 0;
}
