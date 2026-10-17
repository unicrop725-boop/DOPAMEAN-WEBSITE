import { AppError } from '@/lib/errors';
import { commitReservations, reserveStock } from '@/modules/inventory';
import { enqueueEmail, orderCancelledEmail, orderPaidEmail } from '@/modules/notifications';
import {
  getOrderDetail,
  lockOrder,
  reconcilePaymentCaptured,
  recordOrderEvent,
  transitionOrderRow,
  type OrderRow,
} from '@/modules/orders';
import {
  applyCapture,
  completeRefund,
  getPaymentByProviderOrderId,
  listPendingOnlinePayments,
  listRefunds,
  markWebhookProcessed,
  recordAttemptFailure,
  storeWebhookEvent,
  type NormalizedProviderEvent,
  type PaymentProvider,
} from '@/modules/payments';
import { alertStaff, executeRefund, requestRefundTx, type RequestedRefund } from './lifecycle';
import { nowOf, orderUrl, rupees, type CheckoutDeps, type Tx } from './context';

export type ConfirmOutcome =
  | { kind: 'confirmed'; order: OrderRow }
  | { kind: 'already_confirmed' }
  | { kind: 'mismatch' }
  | { kind: 'blocked' }
  | { kind: 'refunded_late_payment'; reason: 'order_cancelled' | 'out_of_stock' };

type CaptureSource = 'webhook' | 'return' | 'reconciliation';

/** Work that must happen AFTER the transaction commits (the provider call of an automatic refund). */
type FollowUp = () => Promise<unknown>;

/**
 * Money has been verified as received (INV-02): the caller is a signature-verified webhook or a
 * server-side provider check, never a browser redirect. Inside the caller's transaction this makes the order
 * consistent with it:
 *  - pending order: sell the held stock (re-reserving if the hold expired, INV-10) and confirm;
 *  - cancelled order, or stock gone: record an automatic full refund request and alert staff;
 *  - already confirmed: nothing to do (duplicates and late events are harmless: INV-04, INV-05).
 * The refund REQUEST is written in the same transaction, so a crash can never lose it; only the provider
 * call is deferred to the returned follow-up (and the worker retries it if that does not complete).
 */
export async function confirmPaidPaymentTx(
  deps: CheckoutDeps,
  tx: Tx,
  paymentId: string,
  capture: { providerPaymentId?: string; amountPaise: number },
  source: CaptureSource,
): Promise<{ outcome: ConfirmOutcome; followUp: FollowUp | null }> {
  const cap = await applyCapture(tx, paymentId, capture);
  const order = await lockOrder(tx, cap.payment.orderId);

  if (cap.outcome === 'blocked') {
    await recordOrderEvent(tx, order.id, 'payment.event_blocked', 'provider', {
      source,
      reason: 'payment is under review',
    });
    return { outcome: { kind: 'blocked' }, followUp: null };
  }

  if (cap.outcome === 'mismatch') {
    await recordOrderEvent(tx, order.id, 'payment.amount_mismatch', 'provider', {
      expectedPaise: cap.payment.amountPaise,
      receivedPaise: capture.amountPaise,
      source,
    });
    await alertStaff(deps, tx, 'Payment amount mismatch', [
      `Order #${order.number}: the provider reports ${rupees(capture.amountPaise)} but ${rupees(cap.payment.amountPaise)} was expected.`,
      'The order was NOT confirmed and the payment is flagged for review.',
    ]);
    return { outcome: { kind: 'mismatch' }, followUp: null };
  }

  const decision = reconcilePaymentCaptured({
    status: order.status,
    fulfillment: order.fulfillmentStatus,
  });
  if (decision.action === 'noop') return { outcome: { kind: 'already_confirmed' }, followUp: null };

  const autoRefund = async (
    reason: 'order_cancelled' | 'out_of_stock',
  ): Promise<{ outcome: ConfirmOutcome; followUp: FollowUp }> => {
    const requested: RequestedRefund = await requestRefundTx(tx, paymentId, capture.amountPaise, {
      actorUserId: null,
      reason:
        reason === 'out_of_stock' ? 'paid after stock ran out' : 'paid after order was cancelled',
      idempotencyKey: `late-payment-refund:${paymentId}`,
    });
    return {
      outcome: { kind: 'refunded_late_payment', reason },
      followUp: () =>
        executeRefund(deps, requested, { actorUserId: null }).catch((err) => {
          // Provider failure is already recorded and alerted; the worker retries stuck refunds.
          if (!(err instanceof AppError && err.code === 'REFUND_FAILED')) throw err;
        }),
    };
  };

  if (decision.action === 'refund_required') {
    await recordOrderEvent(tx, order.id, 'payment.captured_after_cancel', 'provider', {
      source,
      amountPaise: capture.amountPaise,
    });
    await alertStaff(deps, tx, 'Payment received for a cancelled order', [
      `Order #${order.number} was already cancelled when ${rupees(capture.amountPaise)} arrived. It is being refunded automatically.`,
    ]);
    return autoRefund('order_cancelled');
  }

  // Pending order: sell the held stock, or re-reserve it if the hold expired while the customer paid.
  let committed = await commitReservations(tx, order.id);
  if (committed.length === 0) {
    const detail = (await getOrderDetail(tx, order.id))!;
    try {
      await tx.transaction((inner) =>
        reserveStock(inner, {
          refId: order.id,
          items: detail.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
          expiresAt: new Date(nowOf(deps).getTime() + 60_000),
        }),
      );
      committed = await commitReservations(tx, order.id);
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'OUT_OF_STOCK')) throw err;
      await transitionOrderRow(tx, order.id, 'cancel', 'system', {
        reason: 'out_of_stock_after_payment',
      });
      await recordOrderEvent(tx, order.id, 'payment.captured_out_of_stock', 'system', { source });
      await alertStaff(deps, tx, 'Paid order could not be fulfilled', [
        `Order #${order.number} was paid after its stock hold expired and the stock is gone. It was cancelled and is being refunded automatically.`,
      ]);
      const r = await autoRefund('out_of_stock');
      const cancelled = (await lockOrder(tx, order.id))!;
      await enqueueEmail(
        tx,
        orderCancelledEmail({
          to: cancelled.email,
          customerName: cancelled.shippingAddress.fullName,
          orderNumber: cancelled.number,
          totalLabel: rupees(cancelled.totalPaise),
          paymentMethod: cancelled.paymentMethod,
          orderUrl: orderUrl(deps, cancelled),
          lines: detail.lines.map((l) => ({
            name: l.productName,
            option: l.optionLabel,
            qty: l.qty,
            totalLabel: rupees(l.totalPaise),
          })),
          reason: 'an item sold out before your payment arrived',
          refundNote: `${rupees(capture.amountPaise)} is being refunded to your original payment method.`,
        }),
      );
      return r;
    }
  }

  const { order: confirmed } = await transitionOrderRow(tx, order.id, 'confirm', 'provider', {
    payload: { source },
  });
  const detail = (await getOrderDetail(tx, order.id))!;
  await enqueueEmail(
    tx,
    orderPaidEmail({
      to: confirmed.email,
      customerName: confirmed.shippingAddress.fullName,
      orderNumber: confirmed.number,
      totalLabel: rupees(confirmed.totalPaise),
      paymentMethod: confirmed.paymentMethod,
      orderUrl: orderUrl(deps, confirmed),
      lines: detail.lines.map((l) => ({
        name: l.productName,
        option: l.optionLabel,
        qty: l.qty,
        totalLabel: rupees(l.totalPaise),
      })),
    }),
  );
  return { outcome: { kind: 'confirmed', order: confirmed }, followUp: null };
}

/** Stand-alone wrapper (return check, reconciliation, jobs): own transaction, then run the follow-up. */
export async function confirmPaidPayment(
  deps: CheckoutDeps,
  paymentId: string,
  capture: { providerPaymentId?: string; amountPaise: number },
  source: CaptureSource,
): Promise<ConfirmOutcome> {
  const { outcome, followUp } = await deps.db.transaction((tx) =>
    confirmPaidPaymentTx(deps, tx, paymentId, capture, source),
  );
  if (followUp) await followUp();
  return outcome;
}

export type WebhookResult =
  | { status: 200; body: { ok: true; duplicate?: boolean } }
  | { status: 400; body: { ok: false; code: 'PAYMENT_SIGNATURE_INVALID' | 'VALIDATION_FAILED' } };

/**
 * Provider webhook entry point (brief §7.4): verify the signature on the RAW body, store the raw event,
 * drop duplicates on the provider event id, then apply it. Storing and applying happen in ONE transaction:
 * if applying fails the stored row rolls back too, so the provider's retry is processed instead of being
 * dropped as a duplicate. Only the provider call of an automatic refund runs after commit, and its request
 * row is already durable by then.
 */
export async function handleProviderWebhook(
  deps: CheckoutDeps,
  provider: PaymentProvider,
  rawBody: string,
  headers: Headers,
): Promise<WebhookResult> {
  const signature = headers.get('x-razorpay-signature');
  const event = provider.parseWebhook(rawBody, headers);
  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    if (event) {
      // Keep a record of forged attempts for investigation; it never changes any state.
      await storeWebhookEvent(deps.db, {
        provider: provider.name,
        providerEventId: `invalid:${event.eventId}:${Date.now()}`,
        eventType: event.type,
        rawBody,
        signatureOk: false,
      }).catch(() => undefined);
    }
    return { status: 400, body: { ok: false, code: 'PAYMENT_SIGNATURE_INVALID' } };
  }
  if (!event) return { status: 400, body: { ok: false, code: 'VALIDATION_FAILED' } };

  const followUps: FollowUp[] = [];
  const duplicate = await deps.db.transaction(async (tx) => {
    const stored = await storeWebhookEvent(tx, {
      provider: provider.name,
      providerEventId: event.eventId,
      eventType: event.type,
      rawBody,
      signatureOk: true,
    });
    if (stored.duplicate || !stored.id) return true;
    const followUp = await applyProviderEvent(deps, tx, event);
    if (followUp) followUps.push(followUp);
    await markWebhookProcessed(tx, stored.id);
    return false;
  });
  for (const f of followUps) await f();
  return { status: 200, body: { ok: true, ...(duplicate ? { duplicate: true } : {}) } };
}

/** Apply one verified, de-duplicated event inside the caller's transaction. Returns work to run after commit. */
async function applyProviderEvent(
  deps: CheckoutDeps,
  tx: Tx,
  event: NormalizedProviderEvent,
): Promise<FollowUp | null> {
  switch (event.type) {
    case 'payment.captured': {
      if (!event.providerOrderId || event.amountPaise === undefined) return null;
      const payment = await getPaymentByProviderOrderId(tx, event.providerOrderId);
      if (!payment) return null;
      const { followUp } = await confirmPaidPaymentTx(
        deps,
        tx,
        payment.id,
        { providerPaymentId: event.providerPaymentId, amountPaise: event.amountPaise },
        'webhook',
      );
      return followUp;
    }
    case 'payment.failed': {
      if (!event.providerOrderId) return null;
      const payment = await getPaymentByProviderOrderId(tx, event.providerOrderId);
      if (payment) await recordAttemptFailure(tx, payment.id, event.providerPaymentId);
      return null;
    }
    case 'refund.processed': {
      // Normally our own refund flow already completed this; this only heals a missed completion.
      if (!event.providerRefundId || !event.providerOrderId) return null;
      const payment = await getPaymentByProviderOrderId(tx, event.providerOrderId);
      if (!payment) return null;
      const refund = (await listRefunds(tx, payment.id)).find(
        (r) => r.status === 'requested' && r.amountPaise === event.amountPaise,
      );
      if (refund) await completeRefund(tx, refund.id, event.providerRefundId);
      return null;
    }
    default:
      return null;
  }
}

export type ReturnResult = { state: 'confirmed' | 'pending' | 'invalid' };

/**
 * The customer came back from the provider's checkout. The returned signature is verified, then the
 * provider is asked directly whether the payment is captured (INV-02). A redirect alone never marks an order
 * paid; if the provider has not captured yet we simply report "pending" and let the webhook finish the job.
 */
export async function verifyCheckoutReturn(
  deps: CheckoutDeps,
  provider: PaymentProvider,
  input: { providerOrderId: string; providerPaymentId: string; signature: string },
): Promise<ReturnResult> {
  if (!provider.verifyCheckoutSignature(input)) return { state: 'invalid' };
  const payment = await getPaymentByProviderOrderId(deps.db, input.providerOrderId);
  if (!payment) return { state: 'invalid' };
  const payments = await provider.listOrderPayments(input.providerOrderId);
  const paid = payments.find(
    (p) => p.providerPaymentId === input.providerPaymentId && p.status === 'captured',
  );
  if (!paid) return { state: 'pending' };
  const outcome = await confirmPaidPayment(
    deps,
    payment.id,
    { providerPaymentId: paid.providerPaymentId, amountPaise: paid.amountPaise },
    'return',
  );
  return {
    state:
      outcome.kind === 'confirmed' || outcome.kind === 'already_confirmed'
        ? 'confirmed'
        : 'pending',
  };
}

/** Worker: ask the provider about online payments still pending after 30 minutes (brief §7.5). */
export async function reconcilePendingPayments(
  deps: CheckoutDeps,
): Promise<{ checked: number; confirmed: number }> {
  if (!deps.provider) return { checked: 0, confirmed: 0 };
  const pending = await listPendingOnlinePayments(deps.db, 30);
  let confirmed = 0;
  for (const p of pending) {
    if (!p.providerOrderId) continue;
    const list = await deps.provider.listOrderPayments(p.providerOrderId);
    const paid = list.find((x) => x.status === 'captured');
    if (paid) {
      const outcome = await confirmPaidPayment(
        deps,
        p.id,
        { providerPaymentId: paid.providerPaymentId, amountPaise: paid.amountPaise },
        'reconciliation',
      );
      if (outcome.kind === 'confirmed') confirmed++;
    }
  }
  return { checked: pending.length, confirmed };
}
