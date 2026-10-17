import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { order, orderEvent, orderLine, type OrderAddress } from './schema';
import {
  IllegalTransitionError,
  transitionOrder as transitionPure,
  type FulfillmentStatus,
  type OrderCommand,
  type OrderState,
  type OrderStatus,
} from './domain/state';

export { isCancellable, reconcilePaymentCaptured } from './domain/state';
export type { OrderCommand, OrderState, OrderStatus, FulfillmentStatus } from './domain/state';
export type { OrderAddress } from './schema';

export type OrderRow = typeof order.$inferSelect;
export type OrderLineRow = typeof orderLine.$inferSelect;
export type OrderEventRow = typeof orderEvent.$inferSelect;

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** Unguessable 16-character id for URLs (80 bits of randomness). */
export function newPublicId(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += CROCKFORD[bytes[i]! & 31];
  return out;
}

export function newAccessToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type NewOrderLine = Omit<typeof orderLine.$inferInsert, 'id' | 'orderId'>;

export type NewOrderInput = {
  customerId: string | null;
  email: string;
  phone: string;
  paymentMethod: 'online' | 'cod';
  shippingAddress: OrderAddress;
  idempotencyKey: string;
  accessToken: string;
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  codFeePaise: number;
  taxPaise: number;
  totalPaise: number;
  paymentDeadlineAt: Date | null;
  lines: NewOrderLine[];
};

/** Insert an order with its line snapshots and a "placed" event. Call inside the placement transaction. */
export async function insertOrder(tx: DbOrTx, input: NewOrderInput): Promise<OrderRow> {
  const { lines, accessToken, ...fields } = input;
  const [o] = await tx
    .insert(order)
    .values({ ...fields, publicId: newPublicId(), accessTokenHash: hashAccessToken(accessToken) })
    .returning();
  if (!o) throw new Error('order insert failed');
  await tx.insert(orderLine).values(lines.map((l) => ({ ...l, orderId: o.id })));
  await tx.insert(orderEvent).values({
    orderId: o.id,
    type: 'order.placed',
    actor: input.customerId ?? 'guest',
    payload: { totalPaise: input.totalPaise, paymentMethod: input.paymentMethod },
  });
  return o;
}

export async function findOrderByIdempotencyKey(db: DbOrTx, key: string): Promise<OrderRow | null> {
  const [row] = await db.select().from(order).where(eq(order.idempotencyKey, key)).limit(1);
  return row ?? null;
}

export async function getOrder(db: DbOrTx, orderId: string): Promise<OrderRow | null> {
  const [row] = await db.select().from(order).where(eq(order.id, orderId)).limit(1);
  return row ?? null;
}

export type OrderDetail = { order: OrderRow; lines: OrderLineRow[]; events: OrderEventRow[] };

async function detailOf(db: DbOrTx, o: OrderRow): Promise<OrderDetail> {
  const [lines, events] = await Promise.all([
    db
      .select()
      .from(orderLine)
      .where(eq(orderLine.orderId, o.id))
      .orderBy(asc(orderLine.productName), asc(orderLine.sku)),
    db.select().from(orderEvent).where(eq(orderEvent.orderId, o.id)).orderBy(asc(orderEvent.at)),
  ]);
  return { order: o, lines, events };
}

export async function getOrderDetail(db: DbOrTx, orderId: string): Promise<OrderDetail | null> {
  const o = await getOrder(db, orderId);
  return o ? detailOf(db, o) : null;
}

/** A signed-in customer's own order. The owner id is part of the query (INV-13): someone else's id finds nothing. */
export async function getCustomerOrderDetail(
  db: DbOrTx,
  customerId: string,
  publicId: string,
): Promise<OrderDetail | null> {
  const [o] = await db
    .select()
    .from(order)
    .where(and(eq(order.publicId, publicId), eq(order.customerId, customerId)))
    .limit(1);
  return o ? detailOf(db, o) : null;
}

/** A guest reopening an order with the secret from the confirmation link. */
export async function getGuestOrderDetail(
  db: DbOrTx,
  publicId: string,
  accessToken: string,
): Promise<OrderDetail | null> {
  const [o] = await db
    .select()
    .from(order)
    .where(
      and(eq(order.publicId, publicId), eq(order.accessTokenHash, hashAccessToken(accessToken))),
    )
    .limit(1);
  return o ? detailOf(db, o) : null;
}

export async function listCustomerOrders(
  db: DbOrTx,
  customerId: string,
  opts: { page?: number; pageSize?: number } = {},
) {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const where = eq(order.customerId, customerId);
  const [items, [count]] = await Promise.all([
    db
      .select()
      .from(order)
      .where(where)
      .orderBy(desc(order.placedAt), desc(order.number))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(order)
      .where(where),
  ]);
  const total = count?.n ?? 0;
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export type AdminOrderFilter = {
  q?: string;
  status?: OrderStatus;
  fulfillment?: FulfillmentStatus;
  paymentMethod?: 'online' | 'cod';
  sort?: 'newest' | 'oldest' | 'total_desc' | 'total_asc';
  page?: number;
  pageSize?: number;
};

/** Server-side search, filter, sort and pagination for the admin order list (page size capped at 100). */
export async function listOrdersAdmin(db: DbOrTx, f: AdminOrderFilter = {}) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const conds: SQL[] = [];
  if (f.status) conds.push(eq(order.status, f.status));
  if (f.fulfillment) conds.push(eq(order.fulfillmentStatus, f.fulfillment));
  if (f.paymentMethod) conds.push(eq(order.paymentMethod, f.paymentMethod));
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const number = /^#?\d{1,12}$/.test(q) ? Number(q.replace('#', '')) : null;
    const textMatch = or(
      ilike(order.email, like),
      ilike(order.phone, like),
      ilike(order.publicId, like),
      sql`${order.shippingAddress}->>'fullName' ILIKE ${like}`,
    );
    conds.push((number !== null ? or(eq(order.number, number), textMatch) : textMatch) as SQL);
  }
  const where = conds.length ? and(...conds) : undefined;
  const orderBy =
    f.sort === 'oldest'
      ? [asc(order.placedAt), asc(order.number)]
      : f.sort === 'total_desc'
        ? [desc(order.totalPaise), desc(order.number)]
        : f.sort === 'total_asc'
          ? [asc(order.totalPaise), desc(order.number)]
          : [desc(order.placedAt), desc(order.number)];
  const [items, [count]] = await Promise.all([
    db
      .select()
      .from(order)
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(order)
      .where(where),
  ]);
  const total = count?.n ?? 0;
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function recordOrderEvent(
  tx: DbOrTx,
  orderId: string,
  type: string,
  actor: string,
  payload?: unknown,
): Promise<void> {
  await tx.insert(orderEvent).values({ orderId, type, actor, payload: payload ?? null });
}

export type TransitionResult = { from: OrderState; to: OrderState; order: OrderRow };

/**
 * Apply a command to an order under a row lock (INV-05, INV-08, INV-09). Illegal commands throw:
 * ORDER_NOT_CANCELLABLE for a cancel after shipment, ILLEGAL_TRANSITION for everything else.
 */
export async function transitionOrderRow(
  tx: DbOrTx,
  orderId: string,
  command: OrderCommand,
  actor: string,
  opts: { reason?: string; payload?: unknown } = {},
): Promise<TransitionResult> {
  const [current] = await tx.select().from(order).where(eq(order.id, orderId)).for('update');
  if (!current) throw new AppError('NOT_FOUND');
  const from: OrderState = { status: current.status, fulfillment: current.fulfillmentStatus };
  let to: OrderState;
  try {
    to = transitionPure(from, command);
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      throw new AppError(
        command === 'cancel' ? 'ORDER_NOT_CANCELLABLE' : 'ILLEGAL_TRANSITION',
        err.message,
      );
    }
    throw err;
  }
  const [updated] = await tx
    .update(order)
    .set({
      status: to.status,
      fulfillmentStatus: to.fulfillment,
      ...(command === 'cancel'
        ? { cancelledAt: sql`now()`, cancelReason: opts.reason ?? null }
        : {}),
      ...(command === 'deliver' ? { completedAt: sql`now()` } : {}),
    })
    .where(
      and(
        eq(order.id, orderId),
        eq(order.status, from.status),
        eq(order.fulfillmentStatus, from.fulfillment),
      ),
    )
    .returning();
  if (!updated) throw new AppError('ILLEGAL_TRANSITION', 'order changed concurrently');
  await recordOrderEvent(tx, orderId, `order.${command}`, actor, {
    from,
    to,
    reason: opts.reason,
    ...(opts.payload as object | undefined),
  });
  return { from, to, order: updated };
}

/** Lock an order row and return it (used by workflows that must read-then-decide). */
export async function lockOrder(tx: DbOrTx, orderId: string): Promise<OrderRow> {
  const [row] = await tx.select().from(order).where(eq(order.id, orderId)).for('update');
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

/** Unpaid online orders whose payment window has ended. */
export async function listOverdueUnpaid(
  db: DbOrTx,
  now: Date = new Date(),
  limit = 100,
): Promise<OrderRow[]> {
  return db
    .select()
    .from(order)
    .where(
      and(
        eq(order.status, 'pending_payment'),
        sql`${order.paymentDeadlineAt} IS NOT NULL AND ${order.paymentDeadlineAt} <= ${now}`,
      ),
    )
    .orderBy(asc(order.paymentDeadlineAt))
    .limit(limit);
}

export async function countOrdersByStatus(db: DbOrTx): Promise<Record<OrderStatus, number>> {
  const rows = await db
    .select({ status: order.status, n: sql<number>`count(*)::int` })
    .from(order)
    .groupBy(order.status);
  const out: Record<OrderStatus, number> = {
    pending_payment: 0,
    confirmed: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export * from './reports';
