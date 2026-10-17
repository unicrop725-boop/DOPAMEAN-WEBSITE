import { z } from 'zod';
import { getDb } from '@/db/client';
import { ensureCartOwner } from '@/lib/cart-owner';
import { addItem, cartCount, removeItem, setItemQty } from '@/lib/cart-service';
import { assertSameOrigin } from '@/lib/csrf';
import { jsonError } from '@/lib/http';
import { baseLogger } from '@/lib/logger';
import { hitRateLimit } from '@/lib/rate-limit';
import { AppError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

const body = z.object({ variantId: z.string(), qty: z.number().int().min(0).max(10).optional() });

async function guard(req: Request) {
  assertSameOrigin(req);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const limit = await hitRateLimit(getDb(), `cart:${ip}`, 120, 60);
  if (!limit.allowed) throw new AppError('RATE_LIMITED', 'too many requests');
}

async function parse(req: Request) {
  return body.parse(await req.json().catch(() => ({})));
}

/** Add to bag: { variantId, qty } (qty defaults to 1). */
export async function POST(req: Request) {
  try {
    await guard(req);
    const { variantId, qty } = await parse(req);
    const owner = await ensureCartOwner();
    await addItem(getDb(), owner, variantId, qty && qty > 0 ? qty : 1);
    return Response.json(
      { ok: true, count: await cartCount(getDb(), owner) },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (!(err instanceof AppError || err instanceof z.ZodError))
      baseLogger.error({ err }, 'cart add failed');
    return jsonError(err);
  }
}

/** Set an exact quantity: { variantId, qty } (0 removes). */
export async function PATCH(req: Request) {
  try {
    await guard(req);
    const { variantId, qty } = await parse(req);
    if (qty === undefined) throw new AppError('VALIDATION_FAILED', 'qty is required');
    const owner = await ensureCartOwner();
    await setItemQty(getDb(), owner, variantId, qty);
    return Response.json(
      { ok: true, count: await cartCount(getDb(), owner) },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (!(err instanceof AppError || err instanceof z.ZodError))
      baseLogger.error({ err }, 'cart update failed');
    return jsonError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    await guard(req);
    const { variantId } = await parse(req);
    const owner = await ensureCartOwner();
    await removeItem(getDb(), owner, variantId);
    return Response.json(
      { ok: true, count: await cartCount(getDb(), owner) },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (!(err instanceof AppError || err instanceof z.ZodError))
      baseLogger.error({ err }, 'cart remove failed');
    return jsonError(err);
  }
}
