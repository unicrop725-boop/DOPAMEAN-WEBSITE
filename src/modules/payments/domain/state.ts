/**
 * Payment state machine (INV-04, INV-05, INV-08, INV-09). Pure TypeScript.
 *
 *   pending -> captured | failed
 *   captured -> partially_refunded -> refunded   (also captured -> refunded)
 *   any -> needs_review   (reconciliation found a mismatch); only a staff resolution leaves it
 *
 * A single failed ATTEMPT does not fail the payment: the customer may retry and pay. `failed` is final for
 * the order's payment window, but a later real capture is still recorded (money received is never ignored),
 * so failed -> captured is allowed. Stale events never move the payment backwards.
 */
export type PaymentStatus =
  'pending' | 'captured' | 'failed' | 'partially_refunded' | 'refunded' | 'needs_review';

export type PaymentEvent =
  | { type: 'captured' }
  | { type: 'failed' }
  /** `refundedPaise` is the NEW running total; `previousRefundedPaise` what was recorded before. */
  | {
      type: 'refunded';
      refundedPaise: number;
      previousRefundedPaise: number;
      capturedPaise: number;
    }
  | { type: 'flag_review' }
  | { type: 'resolve'; to: Exclude<PaymentStatus, 'needs_review' | 'pending'> };

export class IllegalPaymentTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION' as const;
  constructor(
    readonly from: PaymentStatus,
    readonly event: string,
  ) {
    super(`illegal payment transition: "${event}" from "${from}"`);
    this.name = 'IllegalPaymentTransitionError';
  }
}

export type PaymentDecision =
  { kind: 'transition'; to: PaymentStatus } | { kind: 'ignore'; reason: string };

const MONEY_IN: ReadonlySet<PaymentStatus> = new Set([
  'captured',
  'partially_refunded',
  'refunded',
]);

/** Decide what a provider/system event does to a payment: a transition, an ignore (stale), or an error. */
export function decidePayment(from: PaymentStatus, event: PaymentEvent): PaymentDecision {
  switch (event.type) {
    case 'captured':
      if (from === 'pending' || from === 'failed') return { kind: 'transition', to: 'captured' };
      if (MONEY_IN.has(from)) return { kind: 'ignore', reason: 'already captured' };
      throw new IllegalPaymentTransitionError(from, 'captured'); // needs_review: staff must resolve it
    case 'failed':
      if (from === 'pending') return { kind: 'transition', to: 'failed' };
      // A late failure for an old attempt must not undo a payment that already went through.
      if (from === 'failed' || MONEY_IN.has(from))
        return { kind: 'ignore', reason: 'late failure' };
      throw new IllegalPaymentTransitionError(from, 'failed');
    case 'refunded': {
      if (!MONEY_IN.has(from)) throw new IllegalPaymentTransitionError(from, 'refunded');
      // A stale or duplicate notification can only repeat or shrink the running total: never move backwards.
      if (event.refundedPaise <= event.previousRefundedPaise) {
        return { kind: 'ignore', reason: 'stale refund total' };
      }
      if (event.refundedPaise <= 0 || event.refundedPaise > event.capturedPaise) {
        throw new IllegalPaymentTransitionError(from, 'refunded (amount out of range)');
      }
      return {
        kind: 'transition',
        to: event.refundedPaise === event.capturedPaise ? 'refunded' : 'partially_refunded',
      };
    }
    case 'flag_review':
      if (from === 'needs_review') return { kind: 'ignore', reason: 'already flagged' };
      return { kind: 'transition', to: 'needs_review' };
    case 'resolve':
      if (from !== 'needs_review')
        throw new IllegalPaymentTransitionError(from, `resolve:${event.to}`);
      return { kind: 'transition', to: event.to };
  }
}

/** Strict version: returns the new status, treating an ignorable event as "stay where you are". */
export function nextPaymentStatus(from: PaymentStatus, event: PaymentEvent): PaymentStatus {
  const d = decidePayment(from, event);
  return d.kind === 'transition' ? d.to : from;
}
