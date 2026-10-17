'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { getCheckoutDeps } from '@/lib/checkout-deps';
import { AppError } from '@/lib/errors';
import { baseLogger } from '@/lib/logger';
import { getSessionUser } from '@/lib/session';
import { cancelOrderFlow } from '@/modules/checkout';
import { getCustomerOrderDetail, getGuestOrderDetail } from '@/modules/orders';

/**
 * A customer cancels their own order before it ships (auto-approved while unfulfilled; paid orders are
 * refunded in full). Ownership: a signed-in customer's id is part of the lookup, a guest must present the
 * secret from their order link. Anything else looks like a missing order (INV-13).
 */
export async function cancelMyOrderAction(form: FormData): Promise<void> {
  const publicId = String(form.get('publicId') ?? '');
  const token = String(form.get('token') ?? '');
  const user = await getSessionUser();
  const db = getDb();

  const detail = user
    ? await getCustomerOrderDetail(db, user.id, publicId)
    : await getGuestOrderDetail(db, publicId, token);
  if (!detail) redirect('/');

  const back = user
    ? `/account/orders/${publicId}`
    : `/orders/${publicId}?t=${encodeURIComponent(token)}`;
  try {
    const deps = await getCheckoutDeps();
    await cancelOrderFlow(deps, detail.order.id, {
      actor: 'customer',
      actorId: user?.id ?? 'guest',
      customerId: user?.id,
      reason: 'cancelled by customer',
    });
  } catch (err) {
    if (
      err instanceof AppError &&
      (err.code === 'ORDER_NOT_CANCELLABLE' || err.code === 'ILLEGAL_TRANSITION')
    ) {
      redirect(`${back}${back.includes('?') ? '&' : '?'}notice=not-cancellable`);
    }
    baseLogger.error({ err }, 'customer cancel failed');
    throw err;
  }
  revalidatePath(back);
  redirect(`${back}${back.includes('?') ? '&' : '?'}notice=cancelled`);
}
