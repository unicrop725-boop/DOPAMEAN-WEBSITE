import { AppError } from '@/lib/errors';
import { recordAudit } from '@/modules/audit';
import {
  createShipment,
  markShipmentsDelivered,
  shipInput,
  type ShipInput,
} from '@/modules/fulfillment';
import { listReservations, releaseReservations, restockSold } from '@/modules/inventory';
import {
  enqueueEmail,
  orderCancelledEmail,
  orderRefundedEmail,
  orderShippedEmail,
  staffAlertEmail,
} from '@/modules/notifications';
import {
  getOrder,
  getOrderDetail,
  lockOrder,
  recordOrderEvent,
  transitionOrderRow,
  type OrderDetail,
  type OrderRow,
} from '@/modules/orders';
import {
  completeRefund,
  createRefundRequest,
  failRefund,
  getPaymentByOrderId,
  listAttempts,
  markCodCollected,
  markPaymentFailed,
  type PaymentRow,
  type RefundRow,
} from '@/modules/payments';
import { orderUrl, rupees, type CheckoutDeps, type StaffActor, type Tx } from './context';

async function emailData(deps: CheckoutDeps, tx: Tx, o: OrderRow) {
  const detail = (await getOrderDetail(tx, o.id)) as OrderDetail;
  return {
    to: o.email,
    customerName: o.shippingAddress.fullName,
    orderNumber: o.number,
    totalLabel: rupees(o.totalPaise),
    paymentMethod: o.paymentMethod,
    orderUrl: orderUrl(deps, o),
    lines: detail.lines.map((l) => ({
      name: l.productName,
      option: l.optionLabel,
      qty: l.qty,
      totalLabel: rupees(l.totalPaise),
    })),
  };
}

export async function alertStaff(
  deps: CheckoutDeps,
  tx: Tx,
  subject: string,
  lines: string[],
): Promise<void> {
  if (!deps.staffInbox) return;
  await enqueueEmail(tx, staffAlertEmail({ to: deps.staffInbox, subject, lines }));
}

export type RefundContext = {
  /** User id of the staff member, or null for a system action (late payment, provider timeout). */
  actorUserId: string | null;
  staff?: StaffActor;
  reason: string;
  idempotencyKey?: string;
};

export type RequestedRefund = { refund: RefundRow; payment: PaymentRow };

/**
 * Step 1 of a refund: record the request, reserving the amount (INV-09). Runs inside the caller's
 * transaction so it commits atomically with whatever decided the refund was needed.
 */
export async function requestRefundTx(
  tx: Tx,
  paymentId: string,
  amountPaise: number,
  ctx: RefundContext,
): Promise<RequestedRefund> {
  const actor = ctx.actorUserId ?? 'system';
  const r = await createRefundRequest(tx, paymentId, {
    amountPaise,
    reason: ctx.reason,
    createdBy: ctx.actorUserId ?? undefined,
    idempotencyKey: ctx.idempotencyKey,
  });
  await recordOrderEvent(tx, r.payment.orderId, 'refund.requested', actor, {
    refundId: r.refund.id,
    amountPaise,
    reason: ctx.reason,
  });
  if (ctx.staff) {
    await recordAudit(tx, {
      actor: ctx.staff,
      action: 'order.refund',
      entity: 'order',
      entityId: r.payment.orderId,
      after: { refundId: r.refund.id, amountPaise, reason: ctx.reason },
    });
  }
  return { refund: r.refund, payment: r.payment };
}

/**
 * Steps 2 and 3: call the provider with the request's idempotency key, then record the result. Safe to
 * run again for a request that is still "requested" (the worker does this for stuck ones). COD orders
 * have no provider: the refund is recorded as an offline refund by staff.
 */
export async function executeRefund(
  deps: CheckoutDeps,
  requested: RequestedRefund,
  ctx: Pick<RefundContext, 'actorUserId'>,
): Promise<RefundRow> {
  const actor = ctx.actorUserId ?? 'system';
  const { refund, payment } = requested;
  if (refund.status === 'succeeded') return refund;

  let providerRefundId: string | null = null;
  try {
    if (payment.method === 'online') {
      if (!deps.provider) throw new Error('payment provider is not configured');
      const attempts = await listAttempts(deps.db, payment.id);
      const paid = [...attempts]
        .reverse()
        .find((a) => a.status === 'captured' && a.providerPaymentId);
      if (!paid?.providerPaymentId) throw new Error('no captured provider payment to refund');
      const res = await deps.provider.refund({
        providerPaymentId: paid.providerPaymentId,
        amountPaise: refund.amountPaise,
        idempotencyKey: refund.idempotencyKey,
        notes: { orderId: payment.orderId },
      });
      providerRefundId = res.providerRefundId;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'refund failed';
    await deps.db.transaction(async (tx) => {
      await failRefund(tx, refund.id, message);
      await recordOrderEvent(tx, payment.orderId, 'refund.failed', actor, {
        refundId: refund.id,
        message: message.slice(0, 300),
      });
      await alertStaff(deps, tx, 'Refund failed', [
        `Refund ${refund.id} of ${rupees(refund.amountPaise)} could not be completed.`,
        `Order: ${payment.orderId}`,
        `Reason: ${message.slice(0, 300)}`,
      ]);
    });
    throw new AppError('REFUND_FAILED', message);
  }

  return deps.db.transaction(async (tx) => {
    const done = await completeRefund(tx, refund.id, providerRefundId);
    if (!done.wasAlreadyDone) {
      const o = (await getOrder(tx, payment.orderId))!;
      await recordOrderEvent(tx, o.id, 'refund.succeeded', actor, {
        refundId: done.refund.id,
        amountPaise: refund.amountPaise,
        providerRefundId,
      });
      await enqueueEmail(
        tx,
        orderRefundedEmail({
          ...(await emailData(deps, tx, o)),
          refundLabel: rupees(refund.amountPaise),
        }),
      );
    }
    return done.refund;
  });
}

/** Request and execute a refund in one call (admin refunds, cancellations). */
export async function refundPayment(
  deps: CheckoutDeps,
  paymentId: string,
  amountPaise: number,
  ctx: RefundContext,
): Promise<RefundRow> {
  const requested = await deps.db.transaction((tx) =>
    requestRefundTx(tx, paymentId, amountPaise, ctx),
  );
  return executeRefund(deps, requested, ctx);
}

export type CancelContext = {
  actor: 'customer' | 'staff' | 'system';
  actorId: string;
  reason: string;
  /** Customer cancellations: the cancelling customer's id. A different owner finds nothing (INV-13). */
  customerId?: string;
  staff?: StaffActor;
};

export type CancelResult = { order: OrderRow; refundedPaise: number };

/**
 * Cancel an order that has not shipped (INV-09): stock goes back (released if still held, restocked if it
 * had been sold), and anything already paid is refunded in full. A cancel after shipment is refused.
 */
export async function cancelOrderFlow(
  deps: CheckoutDeps,
  orderId: string,
  ctx: CancelContext,
): Promise<CancelResult> {
  const outcome = await deps.db.transaction(async (tx) => {
    const current = await lockOrder(tx, orderId);
    if (ctx.customerId && current.customerId !== ctx.customerId) throw new AppError('NOT_FOUND');
    const { order, from } = await transitionOrderRow(tx, orderId, 'cancel', ctx.actorId, {
      reason: ctx.reason,
    });

    const reservations = await listReservations(tx, orderId);
    const sold = reservations
      .filter((r) => r.status === 'committed')
      .map((r) => ({ variantId: r.variantId, qty: r.qty }));
    if (sold.length > 0)
      await restockSold(tx, orderId, sold, 'cancellation_restock', ctx.staff?.userId);
    await releaseReservations(tx, orderId, 'released');

    const payment = await getPaymentByOrderId(tx, orderId);
    let refundable = 0;
    if (payment) {
      if (payment.status === 'captured' || payment.status === 'partially_refunded') {
        refundable = payment.capturedPaise - payment.refundedPaise;
      } else if (payment.status === 'pending' && payment.method === 'online') {
        await markPaymentFailed(tx, payment.id);
      }
    }

    if (ctx.staff) {
      await recordAudit(tx, {
        actor: ctx.staff,
        action: 'order.cancel',
        entity: 'order',
        entityId: orderId,
        before: from,
        after: { status: 'cancelled', reason: ctx.reason },
      });
    }
    await enqueueEmail(
      tx,
      orderCancelledEmail({
        ...(await emailData(deps, tx, order)),
        reason:
          ctx.reason === 'payment_timeout' || ctx.reason === 'payment_provider_unavailable'
            ? 'payment was not completed'
            : ctx.reason,
        refundNote:
          refundable > 0
            ? `${rupees(refundable)} will be refunded to your original payment method.`
            : null,
      }),
    );
    return { order, paymentId: payment?.id ?? null, refundable };
  });

  let refundedPaise = 0;
  if (outcome.paymentId && outcome.refundable > 0) {
    // Refund failures are alerted inside refundPayment; the order stays cancelled and the refund can be retried.
    try {
      const r = await refundPayment(deps, outcome.paymentId, outcome.refundable, {
        actorUserId: ctx.actor === 'system' ? null : ctx.actorId,
        reason: `order cancelled: ${ctx.reason}`,
        idempotencyKey: `cancel-refund:${orderId}`,
        staff: ctx.staff,
      });
      refundedPaise = r.status === 'succeeded' ? r.amountPaise : 0;
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'REFUND_FAILED')) throw err;
    }
  }
  return { order: outcome.order, refundedPaise };
}

export async function shipOrderFlow(
  deps: CheckoutDeps,
  orderId: string,
  rawShip: ShipInput,
  staff: StaffActor,
): Promise<OrderRow> {
  const ship = shipInput.parse(rawShip);
  return deps.db.transaction(async (tx) => {
    const { order, from } = await transitionOrderRow(tx, orderId, 'ship', staff.userId, {
      payload: { carrier: ship.carrier },
    });
    const shipment = await createShipment(tx, orderId, ship, staff.userId);
    await recordAudit(tx, {
      actor: staff,
      action: 'order.ship',
      entity: 'order',
      entityId: orderId,
      before: from,
      after: { fulfillment: 'shipped', carrier: shipment.carrier, trackingNo: shipment.trackingNo },
    });
    await enqueueEmail(
      tx,
      orderShippedEmail({
        ...(await emailData(deps, tx, order)),
        carrier: shipment.carrier,
        trackingNo: shipment.trackingNo,
        trackingUrl: shipment.trackingUrl,
      }),
    );
    return order;
  });
}

export async function deliverOrderFlow(
  deps: CheckoutDeps,
  orderId: string,
  staff: StaffActor,
): Promise<OrderRow> {
  return deps.db.transaction(async (tx) => {
    const { order, from } = await transitionOrderRow(tx, orderId, 'deliver', staff.userId);
    await markShipmentsDelivered(tx, orderId);
    await recordAudit(tx, {
      actor: staff,
      action: 'order.deliver',
      entity: 'order',
      entityId: orderId,
      before: from,
      after: { status: 'completed', fulfillment: 'delivered' },
    });
    return order;
  });
}

/** Staff confirm the cash for a COD order was collected (payment pending -> captured). */
export async function collectCodFlow(
  deps: CheckoutDeps,
  orderId: string,
  staff: StaffActor,
): Promise<PaymentRow> {
  return deps.db.transaction(async (tx) => {
    const payment = await getPaymentByOrderId(tx, orderId);
    if (!payment) throw new AppError('NOT_FOUND');
    const updated = await markCodCollected(tx, payment.id);
    await recordOrderEvent(tx, orderId, 'payment.cod_collected', staff.userId, {
      amountPaise: updated.capturedPaise,
    });
    await recordAudit(tx, {
      actor: staff,
      action: 'payment.cod_collected',
      entity: 'order',
      entityId: orderId,
      before: { status: payment.status },
      after: { status: updated.status, capturedPaise: updated.capturedPaise },
    });
    return updated;
  });
}
