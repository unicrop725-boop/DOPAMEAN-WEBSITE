import { redirect } from 'next/navigation';
import { getCurrentStaff, getSessionUser } from '@/lib/session';
import { TwoFactorSetup } from './two-factor-setup';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Two-factor authentication' };

export default async function SecurityPage() {
  if (!(await getSessionUser())) redirect('/admin/login');
  const staff = await getCurrentStaff();
  if (!staff) redirect('/admin/login?error=not-staff');
  if (staff.twoFactorEnabled) redirect('/admin');

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="font-mono text-lg uppercase">Set up two-factor authentication</h1>
      <p className="text-sm">
        The {staff.role} role requires an authenticator app (TOTP). Enter your password to begin.
      </p>
      <TwoFactorSetup />
    </main>
  );
}
