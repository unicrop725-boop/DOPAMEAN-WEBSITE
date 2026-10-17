import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  isCancellable,
  reconcilePaymentCaptured,
  transitionOrder,
  type FulfillmentStatus,
  type OrderCommand,
  type OrderState,
  type OrderStatus,
} from '@/modules/orders/domain/state';
import {
  IllegalPaymentTransitionError,
  decidePayment,
  nextPaymentStatus,
  type PaymentEvent,
  type PaymentStatus,
} from '@/modules/payments/domain/state';

const STATUSES: OrderStatus[] = ['pending_payment', 'confirmed', 'completed', 'cancelled'];
const FULFILLMENTS: FulfillmentStatus[] = ['unfulfilled', 'shipped', 'delivered'];
const COMMANDS: OrderCommand[] = ['confirm', 'cancel', 'ship', 'deliver'];

describe('order state machine (INV-08)', () => {
  const s = (status: OrderStatus, fulfillment: FulfillmentStatus = 'unfulfilled'): OrderState => ({
    status,
    fulfillment,
  });

  it('walks the happy path: pending -> confirmed -> shipped -> completed', () => {
    let state = s('pending_payment');
    state = transitionOrder(state, 'confirm');
    expect(state).toEqual(s('confirmed'));
    state = transitionOrder(state, 'ship');
    expect(state).toEqual(s('confirmed', 'shipped'));
    state = transitionOrder(state, 'deliver');
    expect(state).toEqual(s('completed', 'delivered'));
  });

  it('can be cancelled before payment and before shipment, never after shipment (INV-09)', () => {
    expect(transitionOrder(s('pending_payment'), 'cancel').status).toBe('cancelled');
    expect(transitionOrder(s('confirmed'), 'cancel').status).toBe('cancelled');
    expect(() => transitionOrder(s('confirmed', 'shipped'), 'cancel')).toThrow(
      IllegalTransitionError,
    );
    expect(() => transitionOrder(s('completed', 'delivered'), 'cancel')).toThrow(
      IllegalTransitionError,
    );
  });

  it('exhaustively: every (state, command) pair either yields a legal state or throws', () => {
    const legal = new Set([
      'pending_payment/unfulfilled|confirm|confirmed/unfulfilled',
      'pending_payment/unfulfilled|cancel|cancelled/unfulfilled',
      'confirmed/unfulfilled|cancel|cancelled/unfulfilled',
      'confirmed/unfulfilled|ship|confirmed/shipped',
      'confirmed/shipped|deliver|completed/delivered',
    ]);
    let allowed = 0;
    for (const status of STATUSES) {
      for (const f of FULFILLMENTS) {
        for (const c of COMMANDS) {
          const from = s(status, f);
          const key = `${status}/${f}|${c}`;
          const expected = [...legal].find((l) => l.startsWith(`${key}|`));
          if (expected) {
            const next = transitionOrder(from, c);
            expect(`${next.status}/${next.fulfillment}`).toBe(expected.split('|')[2]);
            allowed++;
          } else {
            expect(() => transitionOrder(from, c), key).toThrow(IllegalTransitionError);
          }
        }
      }
    }
    expect(allowed).toBe(legal.size);
  });

  it('terminal states accept nothing; the input is never mutated', () => {
    const input = s('cancelled');
    for (const c of COMMANDS) expect(() => transitionOrder(input, c)).toThrow();
    expect(input).toEqual(s('cancelled'));
  });

  it('isCancellable mirrors the machine', () => {
    for (const status of STATUSES) {
      for (const f of FULFILLMENTS) {
        let ok = true;
        try {
          transitionOrder({ status, fulfillment: f }, 'cancel');
        } catch {
          ok = false;
        }
        expect(isCancellable({ status, fulfillment: f }), `${status}/${f}`).toBe(ok);
      }
    }
  });
});

describe('late or duplicate payment notifications never move an order backwards (INV-05)', () => {
  it('confirms a pending order exactly once', () => {
    const first = reconcilePaymentCaptured({
      status: 'pending_payment',
      fulfillment: 'unfulfilled',
    });
    expect(first).toEqual({
      action: 'confirm',
      next: { status: 'confirmed', fulfillment: 'unfulfilled' },
    });
    expect(reconcilePaymentCaptured({ status: 'confirmed', fulfillment: 'unfulfilled' })).toEqual({
      action: 'noop',
      reason: 'already_confirmed',
    });
  });

  it('does not touch shipped or completed orders', () => {
    expect(reconcilePaymentCaptured({ status: 'confirmed', fulfillment: 'shipped' }).action).toBe(
      'noop',
    );
    expect(reconcilePaymentCaptured({ status: 'completed', fulfillment: 'delivered' }).action).toBe(
      'noop',
    );
  });

  it('a payment arriving for a cancelled order requires a refund and does not resurrect the order', () => {
    expect(reconcilePaymentCaptured({ status: 'cancelled', fulfillment: 'unfulfilled' })).toEqual({
      action: 'refund_required',
      reason: 'order_cancelled',
    });
  });
});

describe('payment state machine (INV-05, INV-08, INV-09)', () => {
  it('pending -> captured -> partially_refunded -> refunded', () => {
    let p: PaymentStatus = 'pending';
    p = nextPaymentStatus(p, { type: 'captured' });
    expect(p).toBe('captured');
    p = nextPaymentStatus(p, {
      type: 'refunded',
      refundedPaise: 1_000,
      previousRefundedPaise: 0,
      capturedPaise: 5_000,
    });
    expect(p).toBe('partially_refunded');
    p = nextPaymentStatus(p, {
      type: 'refunded',
      refundedPaise: 5_000,
      previousRefundedPaise: 1_000,
      capturedPaise: 5_000,
    });
    expect(p).toBe('refunded');
  });

  it('a late "failed" for an old attempt never undoes a successful payment', () => {
    for (const from of ['captured', 'partially_refunded', 'refunded'] as PaymentStatus[]) {
      expect(decidePayment(from, { type: 'failed' })).toMatchObject({ kind: 'ignore' });
      expect(nextPaymentStatus(from, { type: 'failed' })).toBe(from);
    }
  });

  it('duplicate captured events are ignored (idempotent)', () => {
    expect(decidePayment('captured', { type: 'captured' })).toMatchObject({ kind: 'ignore' });
    expect(decidePayment('refunded', { type: 'captured' })).toMatchObject({ kind: 'ignore' });
  });

  it('money that arrives after a recorded failure is still recorded', () => {
    expect(nextPaymentStatus('failed', { type: 'captured' })).toBe('captured');
  });

  it('cannot refund what was never captured, or more than was captured', () => {
    expect(() =>
      decidePayment('pending', {
        type: 'refunded',
        refundedPaise: 1,
        previousRefundedPaise: 0,
        capturedPaise: 1,
      }),
    ).toThrow(IllegalPaymentTransitionError);
    expect(() =>
      decidePayment('failed', {
        type: 'refunded',
        refundedPaise: 1,
        previousRefundedPaise: 0,
        capturedPaise: 1,
      }),
    ).toThrow(IllegalPaymentTransitionError);
    expect(() =>
      decidePayment('captured', {
        type: 'refunded',
        refundedPaise: 5_001,
        previousRefundedPaise: 0,
        capturedPaise: 5_000,
      }),
    ).toThrow(IllegalPaymentTransitionError);
    expect(() =>
      decidePayment('captured', {
        type: 'refunded',
        refundedPaise: 0,
        previousRefundedPaise: -1,
        capturedPaise: 5_000,
      }),
    ).toThrow(IllegalPaymentTransitionError);
  });

  it('a late or duplicate refund notification with an older total is ignored (never shrinks the refund)', () => {
    const stale = {
      type: 'refunded',
      refundedPaise: 1_000,
      previousRefundedPaise: 5_000,
      capturedPaise: 5_000,
    } as const;
    expect(decidePayment('refunded', stale)).toMatchObject({ kind: 'ignore' });
    expect(nextPaymentStatus('refunded', stale)).toBe('refunded');
    const dup = {
      type: 'refunded',
      refundedPaise: 1_000,
      previousRefundedPaise: 1_000,
      capturedPaise: 5_000,
    } as const;
    expect(nextPaymentStatus('partially_refunded', dup)).toBe('partially_refunded');
  });

  it('needs_review is entered from any state and left only by an explicit staff resolution', () => {
    for (const from of [
      'pending',
      'captured',
      'failed',
      'partially_refunded',
      'refunded',
    ] as PaymentStatus[]) {
      expect(nextPaymentStatus(from, { type: 'flag_review' })).toBe('needs_review');
    }
    expect(() => decidePayment('needs_review', { type: 'captured' })).toThrow(
      IllegalPaymentTransitionError,
    );
    expect(() => decidePayment('needs_review', { type: 'failed' })).toThrow(
      IllegalPaymentTransitionError,
    );
    expect(nextPaymentStatus('needs_review', { type: 'resolve', to: 'captured' })).toBe('captured');
    expect(() => decidePayment('captured', { type: 'resolve', to: 'failed' })).toThrow(
      IllegalPaymentTransitionError,
    );
  });

  it('exhaustive: no event ever moves a payment from a refund state back to pending or captured-less states', () => {
    const states: PaymentStatus[] = [
      'pending',
      'captured',
      'failed',
      'partially_refunded',
      'refunded',
      'needs_review',
    ];
    // The recorded refund total always matches the payment state (it comes from the same database row).
    const recorded: Record<PaymentStatus, number> = {
      pending: 0,
      captured: 0,
      failed: 0,
      partially_refunded: 100,
      refunded: 500,
      needs_review: 0,
    };
    const eventsFor = (from: PaymentStatus): PaymentEvent[] => [
      { type: 'captured' },
      { type: 'failed' },
      {
        type: 'refunded',
        refundedPaise: 100,
        previousRefundedPaise: recorded[from],
        capturedPaise: 500,
      },
      {
        type: 'refunded',
        refundedPaise: 500,
        previousRefundedPaise: recorded[from],
        capturedPaise: 500,
      },
      { type: 'flag_review' },
    ];
    for (const from of states) {
      for (const e of eventsFor(from)) {
        let to: PaymentStatus | 'throws' = 'throws';
        try {
          to = nextPaymentStatus(from, e);
        } catch {
          /* illegal is fine */
        }
        if (to === 'throws') continue;
        if (from === 'refunded') expect(['refunded', 'needs_review']).toContain(to);
        if (from === 'partially_refunded')
          expect(['partially_refunded', 'refunded', 'needs_review']).toContain(to);
        if (from === 'captured')
          expect(['captured', 'partially_refunded', 'refunded', 'needs_review']).toContain(to);
        expect(to).not.toBe('pending');
      }
    }
  });
});
