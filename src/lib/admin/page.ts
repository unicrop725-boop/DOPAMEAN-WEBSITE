import 'server-only';
import { AppError } from '@/lib/errors';
import { requireStaffFor, type AuthorizedStaff } from '@/lib/staff-context';
import type { Permission } from '@/modules/staff';

export type SearchParams = Record<string, string | string[] | undefined>;

export type Gate =
  ({ ok: true } & AuthorizedStaff) | { ok: false; reason: 'FORBIDDEN' | 'TWO_FACTOR_REQUIRED' };

/**
 * Server-side permission check for a page. Not signed in: redirect to sign-in (inside requireStaffFor).
 * Signed in without the permission: `{ ok: false }` so the page renders a clear 403 state, never a blank page.
 */
export async function gate(permission: Permission): Promise<Gate> {
  try {
    return { ok: true, ...(await requireStaffFor(permission)) };
  } catch (err) {
    if (
      err instanceof AppError &&
      (err.code === 'FORBIDDEN' || err.code === 'TWO_FACTOR_REQUIRED')
    ) {
      return { ok: false, reason: err.code };
    }
    throw err;
  }
}

export const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/** A positive integer from the URL, clamped; anything invalid falls back to the default. */
export function intParam(
  v: string | string[] | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(first(v) ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** One of a fixed set of values from the URL, or undefined. */
export function enumParam<T extends string>(
  v: string | string[] | undefined,
  allowed: readonly T[],
): T | undefined {
  const s = first(v);
  return s && (allowed as readonly string[]).includes(s) ? (s as T) : undefined;
}

/** `?a=1&b=2` from defined values only (for pagination and filter links). */
export function queryString(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Valid YYYY-MM-DD or undefined. */
export function dateParam(v: string | string[] | undefined): string | undefined {
  const s = first(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    ? s
    : undefined;
}
