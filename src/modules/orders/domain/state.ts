/**
 * Order and fulfilment state machines (INV-05, INV-08, INV-09). Pure TypeScript.
 *
 *   order:       pending_payment -> confirmed -> completed
 *                pending_payment -> cancelled
 *                confirmed       -> cancelled   (only while nothing has shipped)
 *   fulfilment:  unfulfilled -> shipped -> delivered
 *
 * Operator and customer actions are COMMANDS: an illegal one throws. Provider/system notifications are
 * RECONCILIATIONS: a stale one (for example "paid" after the order is already confirmed) is ignored and
 * can never drag the order backwards.
 */
export type OrderStatus = 'pending_payment' | 'confirmed' | 'completed' | 'cancelled';
export type FulfillmentStatus = 'unfulfilled' | 'shipped' | 'delivered';

export type OrderState = { status: OrderStatus; fulfillment: FulfillmentStatus };

export type OrderCommand =
  | 'confirm' // payment captured, or a COD order accepted
  | 'cancel'
  | 'ship'
  | 'deliver';

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION' as const;
  constructor(
    readonly machine: 'order' | 'payment',
    readonly from: string,
    readonly command: string,
    detail?: string,
  ) {
    super(
      `illegal ${machine} transition: "${command}" from "${from}"${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

/** Apply a command, or throw IllegalTransitionError. Never mutates its input. */
export function transitionOrder(state: OrderState, command: OrderCommand): OrderState {
  const { status, fulfillment } = state;
  const illegal = (detail?: string) =>
    new IllegalTransitionError('order', `${status}/${fulfillment}`, command, detail);

  switch (command) {
    case 'confirm':
      if (status !== 'pending_payment' || fulfillment !== 'unfulfilled') throw illegal();
      return { status: 'confirmed', fulfillment };
    case 'cancel':
      if (status === 'cancelled' || status === 'completed') throw illegal();
      // INV-09: no cancellation once an order has shipped.
      if (fulfillment !== 'unfulfilled') throw illegal('already shipped');
      return { status: 'cancelled', fulfillment };
    case 'ship':
      if (status !== 'confirmed' || fulfillment !== 'unfulfilled') throw illegal();
      return { status, fulfillment: 'shipped' };
    case 'deliver':
      if (status !== 'confirmed' || fulfillment !== 'shipped') throw illegal();
      return { status: 'completed', fulfillment: 'delivered' };
  }
}

export type PaymentCapturedOutcome =
  | { action: 'confirm'; next: OrderState }
  | { action: 'noop'; reason: 'already_confirmed' | 'already_completed' }
  | { action: 'refund_required'; reason: 'order_cancelled' };

/**
 * A payment capture was reported (webhook / return check). What should the order do?
 * Never moves backwards: a cancelled order stays cancelled and the money must go back instead (INV-10).
 */
export function reconcilePaymentCaptured(state: OrderState): PaymentCapturedOutcome {
  switch (state.status) {
    case 'pending_payment':
      return { action: 'confirm', next: transitionOrder(state, 'confirm') };
    case 'confirmed':
      return { action: 'noop', reason: 'already_confirmed' };
    case 'completed':
      return { action: 'noop', reason: 'already_completed' };
    case 'cancelled':
      return { action: 'refund_required', reason: 'order_cancelled' };
  }
}

/** Whether a customer may still ask to cancel (before anything ships). */
export function isCancellable(state: OrderState): boolean {
  return (
    (state.status === 'pending_payment' || state.status === 'confirmed') &&
    state.fulfillment === 'unfulfilled'
  );
}
