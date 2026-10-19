import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { getAuth } from '@/lib/auth';
import { loadStaff, type StaffContext } from '@/modules/staff';

export async function getSessionUser() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

/** The signed-in active staff member, or null (customers and signed-out visitors both give null). */
export async function getCurrentStaff(): Promise<StaffContext | null> {
  const u = await getSessionUser();
  if (!u) return null;
  return loadStaff(getDb(), u.id);
}

/** Signed-in user or a redirect to the login page that returns here afterwards. */
export async function requireUser(nextPath: string) {
  const u = await getSessionUser();
  if (!u) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return u;
}
