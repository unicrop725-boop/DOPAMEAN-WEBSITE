import type { DbOrTx } from '@/db/client';
import { listShipments, type ShipmentRow } from '@/modules/fulfillment';
import { isCancellable, type OrderDetail } from '@/modules/orders';
import {
  getPaymentByOrderId,
  listRefunds,
  type PaymentRow,
  type RefundRow,
} from '@/modules/payments';

export type OrderPageData = {
  detail: OrderDetail;
  payment: PaymentRow | null;
  refunds: RefundRow[];
  shipments: ShipmentRow[];
  cancellable: boolean;
  /** Online order still waiting for money inside its payment window: the customer may pay now. */
  canPayNow: boolean;
};

/** Everything an order page shows, from the database only (the confirmation is server state, never a redirect flag). */
export async function loadOrderPage(
  db: DbOrTx,
  detail: OrderDetail,
  now: Date = new Date(),
): Promise<OrderPageData> {
  const payment = await getPaymentByOrderId(db, detail.order.id);
  const [refunds, shipments] = await Promise.all([
    payment ? listRefunds(db, payment.id) : Promise.resolve([]),
    listShipments(db, detail.order.id),
  ]);
  const o = detail.order;
  return {
    detail,
    payment,
    refunds,
    shipments,
    cancellable: isCancellable({ status: o.status, fulfillment: o.fulfillmentStatus }),
    canPayNow:
      o.status === 'pending_payment' &&
      o.paymentMethod === 'online' &&
      !!payment?.providerOrderId &&
      (!o.paymentDeadlineAt || o.paymentDeadlineAt.getTime() > now.getTime()),
  };
}

const EVENT_LABELS: Record<string, string> = {
  'order.placed': 'Order placed',
  'order.confirm': 'Order confirmed',
  'order.ship': 'Shipped',
  'order.deliver': 'Delivered',
  'order.cancel': 'Order cancelled',
  'payment.cod_collected': 'Cash collected',
  'refund.succeeded': 'Refund issued',
};

/** The timeline a customer may see: plain steps only, never internal notes, alerts or provider details. */
export function customerTimeline(detail: OrderDetail): { at: Date; label: string }[] {
  return detail.events
    .filter((e) => e.type in EVENT_LABELS)
    .map((e) => ({ at: e.at, label: EVENT_LABELS[e.type]! }));
}

/** How a status reads at a glance: green = good, amber = waiting, red = problem, blue = on its way or money returned. */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info';

const STATUS_TONES: Record<string, StatusTone> = {
  pending_payment: 'warning',
  confirmed: 'success',
  completed: 'success',
  cancelled: 'danger',
  unfulfilled: 'warning',
  shipped: 'info',
  delivered: 'success',
  pending: 'warning',
  captured: 'success',
  failed: 'danger',
  partially_refunded: 'info',
  refunded: 'info',
  needs_review: 'warning',
};

export const statusTone = (status: string): StatusTone => STATUS_TONES[status] ?? 'warning';

export const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  unfulfilled: 'Not shipped yet',
  shipped: 'Shipped',
  delivered: 'Delivered',
  pending: 'Pending',
  captured: 'Paid',
  failed: 'Payment failed',
  partially_refunded: 'Partly refunded',
  refunded: 'Refunded',
  needs_review: 'Under review',
};
