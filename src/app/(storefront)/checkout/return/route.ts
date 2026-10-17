import { getCheckoutDeps } from '@/lib/checkout-deps';
import { baseLogger } from '@/lib/logger';
import { getSessionUser } from '@/lib/session';
import { getCustomerOrderDetail } from '@/modules/orders';
import { verifyCheckoutReturn } from '@/modules/checkout';

export const dynamic = 'force-dynamic';

/**
 * The customer comes back from Razorpay's hosted checkout. The signature is verified and Razorpay's API is
 * asked whether the payment is really captured (INV-02); a bare redirect never marks an order paid. The page
 * we send them to shows the status from the database; `paid` is only a hint for which message to show.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const publicId = url.searchParams.get('o') ?? '';
  const token = url.searchParams.get('t');
  const providerOrderId = url.searchParams.get('razorpay_order_id') ?? '';
  const providerPaymentId = url.searchParams.get('razorpay_payment_id') ?? '';
  const signature = url.searchParams.get('razorpay_signature') ?? '';

  const user = await getSessionUser();
  const deps = await getCheckoutDeps();
  let state: 'confirmed' | 'pending' | 'invalid' = 'invalid';
  if (deps.provider && providerOrderId && providerPaymentId && signature) {
    try {
      state = (
        await verifyCheckoutReturn(deps, deps.provider, {
          providerOrderId,
          providerPaymentId,
          signature,
        })
      ).state;
    } catch (err) {
      baseLogger.error({ err }, 'checkout return verification failed');
      state = 'pending';
    }
  }

  const owned = user && publicId ? await getCustomerOrderDetail(deps.db, user.id, publicId) : null;
  const target = owned
    ? `/account/orders/${publicId}?paid=${state}`
    : publicId && token
      ? `/orders/${publicId}?t=${encodeURIComponent(token)}&paid=${state}`
      : '/';
  return new Response(null, {
    status: 303,
    headers: { location: target, 'cache-control': 'no-store' },
  });
}
