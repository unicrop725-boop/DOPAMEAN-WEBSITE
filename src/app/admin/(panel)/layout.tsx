import { redirect } from 'next/navigation';
import { AdminNav, SignOutButton, StatusRegion, type NavItem } from '@/components/admin/nav';
import { getCurrentStaff, getSessionUser } from '@/lib/session';
import { can, requiresTwoFactor, type Permission } from '@/modules/staff';

export const dynamic = 'force-dynamic';

/** Which sections each permission unlocks. Hiding an entry is a convenience; every page checks again on the server. */
const SECTIONS: { href: string; label: string; permission: Permission | null }[] = [
  { href: '/admin', label: 'Dashboard', permission: null },
  { href: '/admin/orders', label: 'Orders', permission: 'orders.view' },
  { href: '/admin/products', label: 'Products', permission: 'catalog.edit' },
  { href: '/admin/inventory', label: 'Inventory', permission: 'inventory.edit' },
  { href: '/admin/customers', label: 'Customers', permission: 'customers.view' },
  { href: '/admin/messages', label: 'Messages', permission: 'customers.view' },
  { href: '/admin/reports', label: 'Reports', permission: 'reports.view' },
  { href: '/admin/content', label: 'Content', permission: 'catalog.edit' },
  { href: '/admin/banners', label: 'Banners', permission: 'catalog.edit' },
  { href: '/admin/audit', label: 'Audit log', permission: 'audit.view' },
  { href: '/admin/staff', label: 'Staff', permission: 'staff.manage' },
  { href: '/admin/settings', label: 'Settings', permission: 'settings.manage' },
];

/** Server-side gate for every admin page: signed in, active staff, and 2FA enrolled where required. */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/admin/login');
  const staff = await getCurrentStaff();
  if (!staff) redirect('/admin/login?error=not-staff');
  if (requiresTwoFactor(staff.role) && !staff.twoFactorEnabled) redirect('/admin/security');

  const items: NavItem[] = SECTIONS.filter(
    (s) => !s.permission || can(staff.role, s.permission),
  ).map(({ href, label }) => ({ href, label }));

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only-focusable absolute left-2 top-2 z-50 border border-ink bg-paper px-3 py-2 font-mono text-xs"
      >
        Skip to content
      </a>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper px-4 py-3 md:px-6">
        <span className="font-mono text-sm uppercase tracking-wide">DOPAMEAN [ADMIN]</span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-text">
            {staff.email} · {staff.role}
          </span>
          <SignOutButton />
        </div>
      </header>
      <div className="mx-auto grid max-w-7xl gap-4 p-4 md:grid-cols-[11rem_minmax(0,1fr)] md:p-6">
        <AdminNav items={items} />
        <main id="main" tabIndex={-1} className="min-w-0">
          <StatusRegion />
          {children}
        </main>
      </div>
    </div>
  );
}
