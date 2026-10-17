import { getDb } from '@/db/client';
import { getEnv } from '@/lib/env';
import { readCartOwner } from '@/lib/cart-owner';
import { getCartView } from '@/lib/cart-service';
import { jsonError } from '@/lib/http';
import { baseLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const view = await getCartView(getDb(), getEnv().PRICING_TOKEN_SECRET, await readCartOwner());
    return Response.json({ ok: true, cart: view }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    baseLogger.error({ err }, 'cart view failed');
    return jsonError(err);
  }
}
