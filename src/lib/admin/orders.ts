import { z } from 'zod';
import type { Db, DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/modules/audit';
import {
  cancelOrderFlow,
  collectCodFlow,
  deliverOrderFlow,
  refundPayment,
  shipOrderFlow,
  type CheckoutDeps,
} from '@/modules/checkout';
import { listShipments, shipInput, type ShipInput } from '@/modules/fulfillment';
import {
  countOrderItems,
  getOrder,
  getOrderDetail,
  listOrdersAdmin,
  recordOrderEvent,
  type AdminOrderFilter,
} from '@/modules/orders';
import {
  getPaymentByOrderId,
  listAttempts,
  listPaymentsByOrderIds,
  listRefunds,
} from '@/modules/payments';
import { assertCan, auditActorOf, type AdminActor } from '@/modules/staff';

/**
 * Admin order operations. The checkout workflows do not check roles, so each one is authorized here
 * (ship/deliver/COD need orders.ship, cancel needs orders.cancel, refund needs orders.refund, notes need
 * orders.note) before it runs. The workflows write their own audit events in the same transaction.
 */

/** A tampered or stale id is just "not found", never a database error. */
function orderIdOf(id: string): string {
  if (!z.uuid().safeParse(id).success) throw new AppError('NOT_FOUND', 'Order not found.');
  return id;
}

export async function shipOrderAdmin(
  deps: CheckoutDeps,
  actor: AdminActor,
  orderId: string,
  rawInput: ShipInput,
) {
  assertCan(actor, 'orders.ship');
  const input = shipInput.parse(rawInput);
  return shipOrderFlow(deps, orderIdOf(orderId), input, auditActorOf(actor));
}

export async function deliverOrderAdmin(deps: CheckoutDeps, actor: AdminActor, orderId: string) {
  assertCan(actor, 'orders.ship');
  return deliverOrderFlow(deps, orderIdOf(orderId), auditActorOf(actor));
}

/** Staff confirm that the cash for a COD order was collected. */
export async function collectCodAdmin(deps: CheckoutDeps, actor: AdminActor, orderId: string) {
  assertCan(actor, 'orders.ship');
  return collectCodFlow(deps, orderIdOf(orderId), auditActorOf(actor));
}

const cancelInput = z.object({
  reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300),
});

export async function cancelOrderAdmin(
  deps: CheckoutDeps,
  actor: AdminActor,
  orderId: string,
  rawInput: z.input<typeof cancelInput>,
) {
  assertCan(actor, 'orders.cancel');
  const { reason } = cancelInput.parse(rawInput);
  return cancelOrderFlow(deps, orderIdOf(orderId), {
    actor: 'staff',
    actorId: actor.userId,
    reason,
    staff: auditActorOf(actor),
  });
}

const refundInput = z.object({
  amountPaise: z
    .number({ error: 'Enter the refund amount' })
    .int('Refund must be a whole number of paise')
    .min(1, 'Refund must be more than zero'),
  reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300),
  /** Same key twice means the same refund (double clicks, retries). */
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
});

/** Refund part or all of what was captured for an order (permission orders.refund). */
export async function refundOrderAdmin(
  deps: CheckoutDeps,
  actor: AdminActor,
  orderId: string,
  rawInput: z.input<typeof refundInput>,
) {
  assertCan(actor, 'orders.refund');
  const parsed = refundInput.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? 'form');
    throw new AppError('VALIDATION_FAILED', issue?.message ?? 'Invalid refund', {
      fieldErrors: { [field]: issue?.message ?? 'Invalid' },
    });
  }
  const input = parsed.data;
  const payment = await getPaymentByOrderId(deps.db, orderIdOf(orderId));
  if (!payment) throw new AppError('NOT_FOUND', 'This order has no payment to refund.');
  return refundPayment(deps, payment.id, input.amountPaise, {
    actorUserId: actor.userId,
    staff: auditActorOf(actor),
    reason: input.reason,
    idempotencyKey: input.idempotencyKey
      ? `admin-refund:${orderId}:${input.idempotencyKey}`
      : undefined,
  });
}

const noteInput = z.object({
  text: z.string().trim().min(1, 'Write a note').max(2000, 'At most 2000 characters'),
});

/** Add an internal note to an order's timeline (permission orders.note). Customers never see it. */
export async function addOrderNote(
  db: Db,
  actor: AdminActor,
  orderId: string,
  rawInput: z.input<typeof noteInput>,
): Promise<void> {
  assertCan(actor, 'orders.note');
  const { text } = noteInput.parse(rawInput);
  await db.transaction(async (tx) => {
    const o = await getOrder(tx, orderIdOf(orderId));
    if (!o) throw new AppError('NOT_FOUND', 'Order not found.');
    await recordOrderEvent(tx, orderId, 'order.note', actor.userId, { text });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'order.note',
      entity: 'order',
      entityId: orderId,
      after: { text },
    });
  });
}

/** Orders list page: server-side filters plus payment status and unit counts for the rows shown. */
export async function listOrdersPage(db: DbOrTx, actor: AdminActor, filter: AdminOrderFilter) {
  assertCan(actor, 'orders.view');
  const list = await listOrdersAdmin(db, filter);
  const ids = list.items.map((o) => o.id);
  const [payments, units] = await Promise.all([
    listPaymentsByOrderIds(db, ids),
    countOrderItems(db, ids),
  ]);
  return {
    ...list,
    items: list.items.map((o) => ({
      order: o,
      paymentStatus: payments.get(o.id)?.status ?? null,
      itemCount: units.get(o.id) ?? 0,
    })),
  };
}

/** Everything the order detail page shows, or null for an unknown order. */
export async function loadOrderPage(db: DbOrTx, actor: AdminActor, orderId: string) {
  assertCan(actor, 'orders.view');
  if (!z.uuid().safeParse(orderId).success) return null;
  const detail = await getOrderDetail(db, orderId);
  if (!detail) return null;
  const payment = await getPaymentByOrderId(db, orderId);
  const [attempts, refunds, shipments] = await Promise.all([
    payment ? listAttempts(db, payment.id) : Promise.resolve([]),
    payment ? listRefunds(db, payment.id) : Promise.resolve([]),
    listShipments(db, orderId),
  ]);
  return { ...detail, payment, attempts, refunds, shipments };
}
