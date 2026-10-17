'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { ensureCartOwner } from '@/lib/cart-owner';
import { removeItem, setItemQty } from '@/lib/cart-service';
import { getCheckoutDeps } from '@/lib/checkout-deps';
import { AppError } from '@/lib/errors';
import { quoteCart } from '@/modules/checkout';

function back(error?: string): never {
  revalidatePath('/cart');
  redirect(error ? `/cart?error=${encodeURIComponent(error)}` : '/cart');
}

/** Change a line quantity by +1 / -1 (or set it). Out-of-range requests come back as a message, never an error page. */
export async function changeQtyAction(form: FormData): Promise<void> {
  const variantId = String(form.get('variantId') ?? '');
  const current = Number(form.get('qty') ?? 0);
  const delta = Number(form.get('delta') ?? 0);
  if (!Number.isInteger(current) || !Number.isInteger(delta)) back('VALIDATION_FAILED');
  try {
    await setItemQty(getDb(), await ensureCartOwner(), variantId, Math.max(0, current + delta));
  } catch (err) {
    if (err instanceof AppError) back(err.code);
    throw err;
  }
  back();
}

export async function removeLineAction(form: FormData): Promise<void> {
  try {
    await removeItem(getDb(), await ensureCartOwner(), String(form.get('variantId') ?? ''));
  } catch (err) {
    if (err instanceof AppError) back(err.code);
    throw err;
  }
  back();
}

/** Drop cart lines whose product is no longer sold. */
export async function dropUnavailableAction(): Promise<void> {
  const deps = await getCheckoutDeps();
  const owner = await ensureCartOwner();
  const { removedVariantIds } = await quoteCart(deps.db, deps.secret, owner, {
    paymentMethod: 'online',
  });
  for (const id of removedVariantIds) await removeItem(deps.db, owner, id);
  back();
}
