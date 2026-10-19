import { ZodError } from 'zod';
import { getDb } from '@/db/client';
import { newsletterInput, subscribeToNewsletter } from '@/lib/newsletter';
import { hitRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip');
}

/**
 * Footer newsletter / wishlist sign-up. Accepts JSON (the page script) or a plain form post (no JS).
 * Honeypot-free by design: it is rate limited per IP instead.
 */
export async function POST(req: Request) {
  const isForm = !(req.headers.get('content-type') ?? '').includes('application/json');
  const body: Record<string, unknown> = isForm
    ? Object.fromEntries((await req.formData()).entries())
    : await req.json().catch(() => ({}));

  const respond = (status: number, payload: { ok: boolean; message: string; field?: string }) =>
    isForm
      ? new Response(null, {
          status: 303,
          headers: { location: `/?newsletter=${payload.ok ? 'ok' : 'error'}` },
        })
      : Response.json(payload, { status });

  const ip = clientIp(req);
  const limit = await hitRateLimit(getDb(), `newsletter:${ip ?? 'unknown'}`, 5, 60 * 60);
  if (!limit.allowed) {
    return Response.json(
      { ok: false, message: 'Too many attempts. Please try again later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const input = newsletterInput.parse({
      firstName: body.firstname ?? body.firstName,
      email: body.email,
      phone: body.phone,
    });
    await subscribeToNewsletter(getDb(), input, ip);
    return respond(200, { ok: true, message: 'Thank you. You are on the list.' });
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return respond(400, {
        ok: false,
        message: issue?.message ?? 'Please check your details.',
        field: String(issue?.path[0] ?? ''),
      });
    }
    throw err;
  }
}
