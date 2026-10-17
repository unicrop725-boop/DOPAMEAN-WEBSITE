import { AppError } from '@/lib/errors';

/**
 * CSRF defence for state-changing route handlers (brief §9): the request must come from our own origin.
 * Browsers always send Origin on cross-site POSTs; a missing Origin on a mutating request is refused too.
 * Server actions get the equivalent check from Next itself, and Better Auth checks its own endpoints.
 */
export function assertSameOrigin(req: Request, allowedHost?: string): void {
  const origin = req.headers.get('origin');
  if (!origin) throw new AppError('CSRF_FAILED', 'missing origin');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError('CSRF_FAILED', 'bad origin');
  }
  const host =
    allowedHost ??
    req.headers.get('x-forwarded-host') ??
    req.headers.get('host') ??
    new URL(req.url).host;
  if (originHost !== host) throw new AppError('CSRF_FAILED', 'cross-site request refused');
}
