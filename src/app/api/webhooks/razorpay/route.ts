import { getCheckoutDeps } from '@/lib/checkout-deps';
import { baseLogger } from '@/lib/logger';
import { handleProviderWebhook } from '@/modules/checkout';

export const dynamic = 'force-dynamic';

/** Hard cap on webhook size: the raw body is read as text and must stay small. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Razorpay webhook (brief §7.4). The signature is verified on the RAW body, the raw event is stored and
 * de-duplicated on its event id, and the state change goes through the state machines. Always answers
 * quickly; a 5xx makes Razorpay retry, which is safe because processing is idempotent (INV-04).
 */
export async function POST(req: Request) {
  const deps = await getCheckoutDeps();
  if (!deps.provider)
    return Response.json({ ok: false, message: 'payments not configured' }, { status: 503 });

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return Response.json({ ok: false }, { status: 413 });
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return Response.json({ ok: false }, { status: 413 });

  try {
    const result = await handleProviderWebhook(deps, deps.provider, rawBody, req.headers);
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    baseLogger.error({ err }, 'webhook processing failed');
    return Response.json({ ok: false }, { status: 500 });
  }
}
