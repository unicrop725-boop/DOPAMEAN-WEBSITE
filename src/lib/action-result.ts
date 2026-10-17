import { ZodError } from 'zod';
import { AppError, type ErrorCode } from '@/lib/errors';
import { baseLogger } from '@/lib/logger';
import { formatRupees, Money } from '@/modules/pricing';

/** What every admin server action returns (SPEC section 8.4): never a stack trace, never a raw database error. */
export type ActionState = {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Stable error code when the failure was an AppError, so the UI can react to it. */
  code?: ErrorCode;
  /** Text the user submitted, returned on failure so the form can show it again (React resets forms after an action). */
  values?: Record<string, string>;
};

export const INITIAL_ACTION_STATE: ActionState = { ok: false };

function friendlyMessage(err: AppError): string {
  switch (err.code) {
    case 'UNAUTHENTICATED':
      return 'Your session has ended. Sign in again.';
    case 'FORBIDDEN':
      // Staff safety rules use FORBIDDEN with their own explanation; plain denials carry no message.
      return err.message === 'FORBIDDEN' ? 'You do not have permission to do this.' : err.message;
    case 'TWO_FACTOR_REQUIRED':
      return 'Set up two-factor authentication before using the admin.';
    case 'ORDER_NOT_CANCELLABLE':
      return 'This order cannot be cancelled any more: it has shipped, been completed, or is already cancelled.';
    case 'ILLEGAL_TRANSITION':
      return 'That action is not allowed while the order is in its current state. Reload the page to see the latest state.';
    case 'REFUND_EXCEEDS_CAPTURED': {
      const available = (err.details as { availablePaise?: number } | undefined)?.availablePaise;
      return typeof available === 'number'
        ? `That is more than can still be refunded. The most you can refund is Rs. ${formatRupees(Money.of(Math.max(available, 0)))}.`
        : 'Nothing is available to refund on this order.';
    }
    case 'REFUND_FAILED':
      return 'The payment provider could not complete the refund. It has been recorded and can be retried.';
    case 'NOT_FOUND':
      return err.message === 'NOT_FOUND' ? 'That record no longer exists.' : err.message;
    case 'OUT_OF_STOCK':
      return err.message === 'OUT_OF_STOCK' ? 'Not enough stock for that change.' : err.message;
    default:
      return err.message === err.code ? 'The request could not be completed.' : err.message;
  }
}

function zodFieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? 'form');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** Convert anything thrown by a module function into a safe ActionState. */
export function toActionError(err: unknown): ActionState {
  if (err instanceof ZodError) {
    return {
      ok: false,
      message: 'Please fix the highlighted fields.',
      fieldErrors: zodFieldErrors(err),
      code: 'VALIDATION_FAILED',
    };
  }
  if (err instanceof AppError) {
    const fieldErrors = (err.details as { fieldErrors?: Record<string, string> } | undefined)
      ?.fieldErrors;
    return {
      ok: false,
      message: friendlyMessage(err),
      ...(fieldErrors ? { fieldErrors } : {}),
      code: err.code,
    };
  }
  baseLogger.error({ err }, 'unexpected error in admin action');
  return { ok: false, message: 'Something went wrong. Nothing was changed. Try again.' };
}

/** The text fields of a submitted form, minus files, framework fields and anything password-like. */
export function formValues(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string' || key.startsWith('$ACTION') || /password|token/i.test(key))
      continue;
    out[key] = value;
  }
  return out;
}

/**
 * Run an admin action body. Return a success message (or nothing) to report success; throw to report
 * failure. Pass the submitted form so a failed submit can show the user's text again. Do not call
 * redirect() inside: return, then redirect after runAction.
 */
export async function runAction(
  body: () => Promise<string | void>,
  form?: FormData,
): Promise<ActionState> {
  try {
    const message = await body();
    return { ok: true, ...(message ? { message } : {}) };
  } catch (err) {
    const state = toActionError(err);
    return form ? { ...state, values: formValues(form) } : state;
  }
}

/** Module functions name fields after their input (`shippingFlatPaise`); forms may use friendlier names. */
export function renameFieldErrors(state: ActionState, names: Record<string, string>): ActionState {
  if (!state.fieldErrors) return state;
  const fieldErrors: Record<string, string> = {};
  for (const [key, message] of Object.entries(state.fieldErrors)) {
    fieldErrors[names[key] ?? key] = message;
  }
  return { ...state, fieldErrors };
}
