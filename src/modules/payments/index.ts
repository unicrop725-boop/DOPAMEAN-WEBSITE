import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { payment, paymentAttempt, refund, webhookEvent } from './schema';
import {
  IllegalPaymentTransitionError,
  decidePayment,
  type PaymentEvent,
  type PaymentStatus,
} from './domain/state';

export type { PaymentProvider, NormalizedProviderEvent, ProviderPayment } from './provider';
export { createRazorpayProvider, razorpayFromEnv } from './razorpay';
export type { PaymentStatus } from './domain/state';

export type PaymentRow = typeof payment.$inferSelect;
export type RefundRow = typeof refund.$inferSelect;

export async function createPayment(
  tx: DbOrTx,
  input: {
    orderId: string;
    method: 'online' | 'cod';
    amountPaise: number;
    provider?: string;
    providerOrderId?: string;
  },
): Promise<PaymentRow> {
  const [row] = await tx.insert(payment).values(input).returning();
  if (!row) throw new Error('payment insert failed');
  if (input.providerOrderId) {
    await tx.insert(paymentAttempt).values({
      paymentId: row.id,
      providerOrderId: input.providerOrderId,
      amountPaise: input.amountPaise,
    });
  }
  return row;
}

/** Attach a provider order to an existing payment (created after the order transaction commits). */
export async function attachProviderOrder(
  tx: DbOrTx,
  paymentId: string,
  provider: string,
  providerOrderId: string,
): Promise<void> {
  const [p] = await tx
    .update(payment)
    .set({ provider, providerOrderId })
    .where(eq(payment.id, paymentId))
    .returning({ amountPaise: payment.amountPaise });
  if (!p) throw new AppError('NOT_FOUND');
  await tx
    .insert(paymentAttempt)
    .values({ paymentId, providerOrderId, amountPaise: p.amountPaise });
}

export async function getPaymentById(db: DbOrTx, id: string): Promise<PaymentRow | null> {
  const [row] = await db.select().from(payment).where(eq(payment.id, id)).limit(1);
  return row ?? null;
}

export async function getPaymentByOrderId(db: DbOrTx, orderId: string): Promise<PaymentRow | null> {
  const [row] = await db.select().from(payment).where(eq(payment.orderId, orderId)).limit(1);
  return row ?? null;
}

export async function getPaymentByProviderOrderId(
  db: DbOrTx,
  providerOrderId: string,
): Promise<PaymentRow | null> {
  const [row] = await db
    .select()
    .from(payment)
    .where(eq(payment.providerOrderId, providerOrderId))
    .limit(1);
  return row ?? null;
}

export async function listPaymentsByOrderIds(
  db: DbOrTx,
  orderIds: string[],
): Promise<Map<string, PaymentRow>> {
  const out = new Map<string, PaymentRow>();
  if (orderIds.length === 0) return out;
  for (const p of await db.select().from(payment).where(inArray(payment.orderId, orderIds)))
    out.set(p.orderId, p);
  return out;
}

async function lockPayment(tx: DbOrTx, paymentId: string): Promise<PaymentRow> {
  const [row] = await tx.select().from(payment).where(eq(payment.id, paymentId)).for('update');
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

function decide(from: PaymentStatus, event: PaymentEvent) {
  try {
    return decidePayment(from, event);
  } catch (err) {
    if (err instanceof IllegalPaymentTransitionError)
      throw new AppError('ILLEGAL_TRANSITION', err.message);
    throw err;
  }
}

export type CaptureOutcome =
  | { outcome: 'captured'; payment: PaymentRow }
  | { outcome: 'ignored'; payment: PaymentRow }
  | { outcome: 'mismatch'; payment: PaymentRow }
  | { outcome: 'blocked'; payment: PaymentRow };

/**
 * Record that money was received (INV-02): call this ONLY from a signature-verified webhook or a
 * server-side provider check. The amount must equal what we asked for; any difference flags the payment
 * for review instead of marking it paid. Safe to call repeatedly (INV-04, INV-05).
 */
export async function applyCapture(
  tx: DbOrTx,
  paymentId: string,
  input: { providerPaymentId?: string; amountPaise: number },
): Promise<CaptureOutcome> {
  const p = await lockPayment(tx, paymentId);
  // Parked for staff review: events may not capture it (only an explicit resolution can).
  if (p.status === 'needs_review') return { outcome: 'blocked', payment: p };
  if (input.amountPaise !== p.amountPaise) {
    await tx.update(payment).set({ status: 'needs_review' }).where(eq(payment.id, p.id));
    return { outcome: 'mismatch', payment: { ...p, status: 'needs_review' } };
  }
  const d = decide(p.status, { type: 'captured' });
  if (d.kind === 'ignore') return { outcome: 'ignored', payment: p };
  const [updated] = await tx
    .update(payment)
    .set({ status: d.to, capturedPaise: input.amountPaise })
    .where(and(eq(payment.id, p.id), eq(payment.status, p.status)))
    .returning();
  if (!updated) return { outcome: 'ignored', payment: p };
  if (input.providerPaymentId) {
    await tx
      .update(paymentAttempt)
      .set({ status: 'captured', providerPaymentId: input.providerPaymentId })
      // Any earlier state (created, failed, or expired after a cancel): the money really arrived, and a
      // later refund needs to know which provider payment to refund.
      .where(eq(paymentAttempt.paymentId, p.id));
  }
  return { outcome: 'captured', payment: updated };
}

/** A single attempt failed. The payment stays pending: the customer may retry within the window. */
export async function recordAttemptFailure(
  tx: DbOrTx,
  paymentId: string,
  providerPaymentId?: string,
): Promise<void> {
  await tx
    .update(paymentAttempt)
    .set({ status: 'failed', providerPaymentId: providerPaymentId ?? null })
    .where(and(eq(paymentAttempt.paymentId, paymentId), eq(paymentAttempt.status, 'created')));
}

/** The payment window ended without money: pending -> failed (a late capture is still recorded later). */
export async function markPaymentFailed(tx: DbOrTx, paymentId: string): Promise<void> {
  const p = await lockPayment(tx, paymentId);
  const d = decide(p.status, { type: 'failed' });
  if (d.kind === 'transition') {
    await tx.update(payment).set({ status: d.to }).where(eq(payment.id, p.id));
    await tx
      .update(paymentAttempt)
      .set({ status: 'expired' })
      .where(and(eq(paymentAttempt.paymentId, p.id), eq(paymentAttempt.status, 'created')));
  }
}

/** Staff confirm that cash was collected for a COD order. */
export async function markCodCollected(tx: DbOrTx, paymentId: string): Promise<PaymentRow> {
  const p = await lockPayment(tx, paymentId);
  if (p.method !== 'cod')
    throw new AppError('ILLEGAL_TRANSITION', 'not a cash on delivery payment');
  const d = decide(p.status, { type: 'captured' });
  if (d.kind === 'ignore') return p;
  const [updated] = await tx
    .update(payment)
    .set({ status: d.to, capturedPaise: p.amountPaise })
    .where(eq(payment.id, p.id))
    .returning();
  return updated!;
}

export async function flagPaymentForReview(tx: DbOrTx, paymentId: string): Promise<void> {
  const p = await lockPayment(tx, paymentId);
  const d = decide(p.status, { type: 'flag_review' });
  if (d.kind === 'transition')
    await tx.update(payment).set({ status: d.to }).where(eq(payment.id, p.id));
}

// ---- webhook storage ------------------------------------------------------------------------

/** Store a provider notification once. A redelivery of the same event id returns { duplicate: true } (INV-04). */
export async function storeWebhookEvent(
  db: DbOrTx,
  input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    rawBody: string;
    signatureOk: boolean;
  },
): Promise<{ duplicate: boolean; id: string | null }> {
  const [row] = await db
    .insert(webhookEvent)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: webhookEvent.id });
  return row ? { duplicate: false, id: row.id } : { duplicate: true, id: null };
}

export async function markWebhookProcessed(db: DbOrTx, id: string, error?: string): Promise<void> {
  await db
    .update(webhookEvent)
    .set({ processedAt: sql`now()`, error: error ?? null })
    .where(eq(webhookEvent.id, id));
}

// ---- refunds --------------------------------------------------------------------------------

/**
 * Step 1 of a refund: reserve the amount (INV-09). Refunds already requested or done count against the
 * captured total, so two admins cannot together refund more than was paid. The row is written BEFORE the
 * provider is called, with an idempotency key the provider also receives.
 */
export async function createRefundRequest(
  tx: DbOrTx,
  paymentId: string,
  input: { amountPaise: number; reason?: string; createdBy?: string; idempotencyKey?: string },
): Promise<{ refund: RefundRow; payment: PaymentRow }> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'refund amount must be a positive whole number of paise',
    );
  }
  const p = await lockPayment(tx, paymentId);
  if (!['captured', 'partially_refunded'].includes(p.status)) {
    throw new AppError('REFUND_EXCEEDS_CAPTURED', 'nothing has been captured to refund');
  }
  const [committed] = await tx
    .select({ n: sql<number>`COALESCE(SUM(${refund.amountPaise}), 0)::bigint` })
    .from(refund)
    .where(and(eq(refund.paymentId, p.id), inArray(refund.status, ['requested'])));
  const inFlight = Number(committed?.n ?? 0);
  const available = p.capturedPaise - p.refundedPaise - inFlight;
  if (input.amountPaise > available) {
    throw new AppError('REFUND_EXCEEDS_CAPTURED', `only ${available} paise can still be refunded`, {
      availablePaise: available,
    });
  }
  const [row] = await tx
    .insert(refund)
    .values({
      paymentId: p.id,
      amountPaise: input.amountPaise,
      reason: input.reason,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey ?? `refund:${p.id}:${randomUUID()}`,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { refund: row, payment: p };
  // Same idempotency key replayed: return the original request instead of creating a second refund.
  const [existing] = await tx
    .select()
    .from(refund)
    .where(eq(refund.idempotencyKey, input.idempotencyKey!));
  return { refund: existing!, payment: p };
}

/** Step 3 (success): the provider (or the cashier, for COD) confirmed the money went back. */
export async function completeRefund(
  tx: DbOrTx,
  refundId: string,
  providerRefundId: string | null,
): Promise<{ refund: RefundRow; payment: PaymentRow; wasAlreadyDone: boolean }> {
  const [r] = await tx.select().from(refund).where(eq(refund.id, refundId)).for('update');
  if (!r) throw new AppError('NOT_FOUND');
  const p = await lockPayment(tx, r.paymentId);
  if (r.status === 'succeeded') return { refund: r, payment: p, wasAlreadyDone: true };
  const newTotal = p.refundedPaise + r.amountPaise;
  const d = decide(p.status, {
    type: 'refunded',
    refundedPaise: newTotal,
    previousRefundedPaise: p.refundedPaise,
    capturedPaise: p.capturedPaise,
  });
  const [updatedPayment] = await tx
    .update(payment)
    .set({ refundedPaise: newTotal, ...(d.kind === 'transition' ? { status: d.to } : {}) })
    .where(eq(payment.id, p.id))
    .returning();
  const [updatedRefund] = await tx
    .update(refund)
    .set({ status: 'succeeded', providerRefundId })
    .where(eq(refund.id, r.id))
    .returning();
  return { refund: updatedRefund!, payment: updatedPayment!, wasAlreadyDone: false };
}

/** Step 3 (failure): the provider rejected the refund; the reserved amount is released. */
export async function failRefund(tx: DbOrTx, refundId: string, error: string): Promise<void> {
  await tx
    .update(refund)
    .set({ status: 'failed', meta: { error: error.slice(0, 500) } })
    .where(and(eq(refund.id, refundId), eq(refund.status, 'requested')));
}

export async function listRefunds(db: DbOrTx, paymentId: string): Promise<RefundRow[]> {
  return db
    .select()
    .from(refund)
    .where(eq(refund.paymentId, paymentId))
    .orderBy(asc(refund.createdAt));
}

/** Refund requests that never got an answer (process crashed between steps): the worker retries them. */
export async function listStuckRefunds(db: DbOrTx, olderThanMinutes = 5): Promise<RefundRow[]> {
  return db
    .select()
    .from(refund)
    .where(
      and(
        eq(refund.status, 'requested'),
        lt(refund.createdAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
      ),
    )
    .orderBy(asc(refund.createdAt))
    .limit(50);
}

/** Pending online payments with no capture after `olderThanMinutes`: candidates for reconciliation. */
export async function listPendingOnlinePayments(
  db: DbOrTx,
  olderThanMinutes = 30,
): Promise<PaymentRow[]> {
  return db
    .select()
    .from(payment)
    .where(
      and(
        eq(payment.method, 'online'),
        eq(payment.status, 'pending'),
        sql`${payment.providerOrderId} IS NOT NULL`,
        lt(payment.createdAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
      ),
    )
    .orderBy(desc(payment.createdAt))
    .limit(100);
}

export async function listAttempts(db: DbOrTx, paymentId: string) {
  return db
    .select()
    .from(paymentAttempt)
    .where(eq(paymentAttempt.paymentId, paymentId))
    .orderBy(asc(paymentAttempt.createdAt));
}
