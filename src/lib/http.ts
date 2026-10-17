import { ZodError } from 'zod';
import { AppError, type ErrorCode } from '@/lib/errors';

/** JSON error response using the stable error codes shared by API and UI (SPEC §8.4). */
export function jsonError(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(
      { ok: false, code: err.code, message: err.message, details: err.details },
      { status: err.status },
    );
  }
  if (err instanceof ZodError) {
    return Response.json(
      {
        ok: false,
        code: 'VALIDATION_FAILED' satisfies ErrorCode,
        message: err.issues[0]?.message ?? 'invalid input',
      },
      { status: 400 },
    );
  }
  // Never leak internals: the real error is logged by the caller.
  return Response.json(
    { ok: false, code: 'INTERNAL', message: 'Something went wrong.' },
    { status: 500 },
  );
}
