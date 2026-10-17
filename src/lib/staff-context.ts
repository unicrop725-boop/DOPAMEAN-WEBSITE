import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppError } from '@/lib/errors';
import { getCurrentStaff } from '@/lib/session';
import { assertCan, type Permission, type StaffContext } from '@/modules/staff';
import type { StaffActor } from '@/modules/checkout';

export type AuthorizedStaff = { staff: StaffContext; actor: StaffActor };

/**
 * Server-side authorization for every admin read and write (brief §9: hidden buttons are not security).
 * Not signed in (or not staff): redirect to the admin sign-in. Signed in but missing the permission, or
 * 2FA not enrolled where required: throws FORBIDDEN / TWO_FACTOR_REQUIRED.
 * `actor` carries the request's IP and user agent for the audit log (INV-14).
 */
export async function requireStaffFor(permission: Permission): Promise<AuthorizedStaff> {
  const staff = await getCurrentStaff();
  if (!staff) redirect('/admin/login');
  assertCan(staff, permission); // throws AppError
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
  return {
    staff,
    actor: { userId: staff.userId, role: staff.role, ip, userAgent: h.get('user-agent') },
  };
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
