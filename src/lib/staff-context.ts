import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppError } from '@/lib/errors';
import { getCurrentStaff } from '@/lib/session';
import { assertCan, type AdminActor, type Permission, type StaffContext } from '@/modules/staff';
import type { StaffActor } from '@/modules/checkout';

export type AuthorizedStaff = {
  staff: StaffContext;
  /** The audit actor (user id, role, ip, user agent). */
  actor: StaffActor;
  /** The staff context plus request metadata: pass this to module functions `fn(db, admin, input)`. */
  admin: AdminActor;
};

/**
 * Authorize the current request without redirecting. Throws UNAUTHENTICATED when nobody (or no staff
 * member) is signed in, FORBIDDEN when the role lacks the permission, TWO_FACTOR_REQUIRED when 2FA is
 * required but not enrolled. Route handlers use this directly; pages and actions use requireStaffFor.
 */
export async function resolveStaffFor(permission: Permission): Promise<AuthorizedStaff> {
  const staff = await getCurrentStaff();
  if (!staff) throw new AppError('UNAUTHENTICATED');
  assertCan(staff, permission);
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
  const userAgent = h.get('user-agent');
  return {
    staff,
    actor: { userId: staff.userId, role: staff.role, ip, userAgent },
    admin: { ...staff, ip, userAgent },
  };
}

/**
 * Server-side authorization for every admin read and write (brief §9: hidden buttons are not security).
 * Not signed in (or not staff): redirect to the admin sign-in. Signed in but missing the permission, or
 * 2FA not enrolled where required: throws FORBIDDEN / TWO_FACTOR_REQUIRED.
 * `actor` carries the request's IP and user agent for the audit log (INV-14).
 */
export async function requireStaffFor(permission: Permission): Promise<AuthorizedStaff> {
  try {
    return await resolveStaffFor(permission);
  } catch (err) {
    if (err instanceof AppError && err.code === 'UNAUTHENTICATED') redirect('/admin/login');
    throw err;
  }
}

/** Same check but returns null instead of throwing, for pages that show or hide controls by role. */
export async function tryStaffFor(permission: Permission): Promise<AuthorizedStaff | null> {
  try {
    return await requireStaffFor(permission);
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
}
