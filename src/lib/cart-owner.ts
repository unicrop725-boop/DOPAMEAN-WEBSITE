import 'server-only';
import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { getSessionUser } from '@/lib/session';
import { mergeAnonymousCart, newAnonToken, type CartOwner } from '@/modules/cart';

export const CART_COOKIE = 'dpm_cart';
const THIRTY_DAYS = 60 * 60 * 24 * 30;

/**
 * Who owns the cart for this request, without changing anything (safe in server components):
 * the signed-in customer, else the anonymous cookie token, else nobody yet.
 */
export async function readCartOwner(): Promise<CartOwner | null> {
  const user = await getSessionUser();
  const token = (await cookies()).get(CART_COOKIE)?.value;
  if (user) {
    // A guest who just signed in keeps their bag. The merge is database-only and idempotent (the guest cart
    // is deleted by it); the stale cookie is cleared by the next route handler or action (ensureCartOwner).
    if (token) await mergeAnonymousCart(getDb(), token, user.id);
    return { customerId: user.id };
  }
  return token ? { anonToken: token } : null;
}

/**
 * For route handlers and server actions only (they may set cookies): returns the owner, creating the
 * anonymous cookie when needed and merging a guest cart into the customer's cart after sign-in.
 */
export async function ensureCartOwner(): Promise<CartOwner> {
  const jar = await cookies();
  const user = await getSessionUser();
  const existing = jar.get(CART_COOKIE)?.value;
  if (user) {
    if (existing) {
      await mergeAnonymousCart(getDb(), existing, user.id);
      jar.delete(CART_COOKIE);
    }
    return { customerId: user.id };
  }
  if (existing) return { anonToken: existing };
  const token = newAnonToken();
  jar.set(CART_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: THIRTY_DAYS,
  });
  return { anonToken: token };
}
