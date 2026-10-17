import 'server-only';
import { getDb } from '@/db/client';
import { getEnv } from '@/lib/env';
import { getSettings } from '@/lib/settings';
import { razorpayFromEnv } from '@/modules/payments';
import type { CheckoutDeps } from '@/modules/checkout';

/**
 * Real checkout wiring from the environment: database, secrets, Razorpay (null when not configured, in
 * which case only cash on delivery is offered) and timing rules. Used by pages, actions and the worker.
 */
export async function getCheckoutDeps(): Promise<CheckoutDeps> {
  const env = getEnv();
  const db = getDb();
  const settings = await getSettings(db);
  return {
    db,
    secret: env.PRICING_TOKEN_SECRET,
    provider: razorpayFromEnv(),
    baseUrl: env.APP_URL,
    reservationTtlMinutes: env.RESERVATION_TTL_MINUTES,
    paymentDeadlineMinutes: env.ORDER_PAYMENT_DEADLINE_MINUTES,
    staffInbox: settings.contactEmail ?? env.CONTACT_INBOX ?? null,
  };
}
