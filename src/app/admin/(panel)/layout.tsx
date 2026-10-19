import { redirect } from 'next/navigation';
import { getCurrentStaff, getSessionUser } from '@/lib/session';
import { requiresTwoFactor } from '@/modules/staff';

export const dynamic = 'force-dynamic';

/** Server-side gate for every admin page: signed in, active staff, and 2FA enrolled where required. */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/admin/login');
  const staff = await getCurrentStaff();
  if (!staff) redirect('/admin/login?error=not-staff');
  if (requiresTwoFactor(staff.role) && !staff.twoFactorEnabled) redirect('/admin/security');

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-line bg-paper px-6 py-3">
        <span className="font-mono text-sm uppercase tracking-wide">DOPAMEAN [ADMIN]</span>
        <span className="font-mono text-xs text-muted">
          {staff.email} · {staff.role}
        </span>
      </header>
      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}
