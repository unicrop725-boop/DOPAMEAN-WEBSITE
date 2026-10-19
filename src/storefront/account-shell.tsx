import Link from 'next/link';
import { PageShell, PageTitle } from './shell';

const LINKS = [
  { href: '/account', label: 'Overview' },
  { href: '/account/orders', label: 'Orders' },
  { href: '/account/addresses', label: 'Addresses' },
  { href: '/account/privacy', label: 'Privacy' },
] as const;

export function AccountShell({
  current,
  title,
  children,
}: {
  current: (typeof LINKS)[number]['href'];
  title: string;
  children: React.ReactNode;
}) {
  return (
    <PageShell>
      <div className="sp-medium">
        <PageTitle>{title}</PageTitle>
        <nav className="sp-subnav" aria-label="Account">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={l.href === current ? 'page' : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        {children}
      </div>
    </PageShell>
  );
}
