import { createHmac } from 'node:crypto';
import type { Db, DbOrTx } from '@/db/client';
import type { PaymentProvider } from '@/modules/payments';
import { Money, formatRupees } from '@/modules/pricing';
import type { OrderRow } from '@/modules/orders';

/** Everything the checkout workflows need from the outside world, passed in so tests can supply their own. */
export type CheckoutDeps = {
  db: Db;
  /** HMAC secret for pricing tokens and guest order links. */
  secret: string;
  /** Null when online payment is not configured: only COD is offered. */
  provider: PaymentProvider | null;
  baseUrl: string;
  reservationTtlMinutes: number;
  paymentDeadlineMinutes: number;
  /** Where internal alerts go (late payment auto-refund, amount mismatch, refund failure). */
  staffInbox: string | null;
  now?: () => Date;
};

export const nowOf = (deps: CheckoutDeps): Date => (deps.now ? deps.now() : new Date());

/** Guest order access token. Derived from the idempotency key, so a replayed request gets the same link. */
export function deriveAccessToken(secret: string, idempotencyKey: string): string {
  return createHmac('sha256', secret).update(`order-access:${idempotencyKey}`).digest('base64url');
}

export function orderUrl(
  deps: Pick<CheckoutDeps, 'secret' | 'baseUrl'>,
  o: Pick<OrderRow, 'publicId' | 'customerId' | 'idempotencyKey'>,
): string {
  if (o.customerId) return `${deps.baseUrl}/account/orders/${o.publicId}`;
  return `${deps.baseUrl}/orders/${o.publicId}?t=${deriveAccessToken(deps.secret, o.idempotencyKey)}`;
}

export const rupees = (paise: number): string => `Rs. ${formatRupees(Money.of(paise))}`;

export type Tx = DbOrTx;

export type StaffActor = {
  userId: string;
  role: 'owner' | 'manager' | 'support';
  ip?: string | null;
  userAgent?: string | null;
};
