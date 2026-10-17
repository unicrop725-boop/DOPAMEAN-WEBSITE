import { expireDueReservations } from '@/modules/inventory';
import { listOverdueUnpaid } from '@/modules/orders';
import { getPaymentById, getPaymentByOrderId, listStuckRefunds } from '@/modules/payments';
import { cancelOrderFlow, executeRefund } from './lifecycle';
import { nowOf, type CheckoutDeps } from './context';
import { confirmPaidPayment } from './payment-flow';

/** Release stock holds whose 15 minutes are up (INV-10). The order itself stays pending until its deadline. */
export async function expireReservationsJob(deps: CheckoutDeps): Promise<{ expired: number }> {
  const expired = await expireDueReservations(deps.db, nowOf(deps));
  return { expired: expired.length };
}

/**
 * Cancel online orders that were never paid within the deadline (SPEC §4.5). The provider is asked first:
 * a payment that was captured but whose webhook never arrived confirms the order instead of cancelling it.
 */
export async function cancelUnpaidOrdersJob(
  deps: CheckoutDeps,
): Promise<{ cancelled: number; rescued: number }> {
  const overdue = await listOverdueUnpaid(deps.db, nowOf(deps));
  let cancelled = 0;
  let rescued = 0;
  for (const o of overdue) {
    const payment = await getPaymentByOrderId(deps.db, o.id);
    if (payment?.providerOrderId && deps.provider) {
      const list = await deps.provider.listOrderPayments(payment.providerOrderId);
      const paid = list.find((p) => p.status === 'captured');
      if (paid) {
        const r = await confirmPaidPayment(
          deps,
          payment.id,
          { providerPaymentId: paid.providerPaymentId, amountPaise: paid.amountPaise },
          'reconciliation',
        );
        if (r.kind === 'confirmed') rescued++;
        continue;
      }
    }
    await cancelOrderFlow(deps, o.id, {
      actor: 'system',
      actorId: 'system',
      reason: 'payment_timeout',
    });
    cancelled++;
  }
  return { cancelled, rescued };
}

/** Retry refunds that were requested but never answered (the process died between the steps). */
export async function retryStuckRefundsJob(deps: CheckoutDeps): Promise<{ retried: number }> {
  const stuck = await listStuckRefunds(deps.db, 5);
  let retried = 0;
  for (const refund of stuck) {
    const payment = await getPaymentById(deps.db, refund.paymentId);
    if (!payment) continue;
    try {
      // Same idempotency key: the provider returns the original refund instead of refunding twice.
      await executeRefund(deps, { refund, payment }, { actorUserId: refund.createdBy ?? null });
      retried++;
    } catch {
      // Already alerted inside executeRefund; it is retried on the next run.
    }
  }
  return { retried };
}
