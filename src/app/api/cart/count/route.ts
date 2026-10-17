import { getDb } from '@/db/client';
import { readCartOwner } from '@/lib/cart-owner';
import { cartCount } from '@/lib/cart-service';
import { jsonError } from '@/lib/http';
import { baseLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/** Item count for the BAG[n] label in the header. Read-only: never creates a cart or sets a cookie. */
export async function GET() {
  try {
    const count = await cartCount(getDb(), await readCartOwner());
    return Response.json({ ok: true, count }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    baseLogger.error({ err }, 'cart count failed');
    return jsonError(err);
  }
}
