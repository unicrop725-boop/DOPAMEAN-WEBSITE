'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { STATUS_EVENT } from './confirm-action';

export type NavItem = { href: string; label: string };

/** Left navigation. The server decides which entries the role may see; every page still re-checks. */
export function AdminNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname() ?? '';
  return (
    <nav aria-label="Admin sections" className="md:sticky md:top-4 md:self-start">
      <ul className="flex flex-wrap gap-1 md:flex-col">
        {items.map((item) => {
          const active =
            item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'block border px-3 py-1.5 font-mono text-xs uppercase tracking-wide',
                  active
                    ? 'border-ink bg-ink text-paper'
                    : 'border-transparent hover:border-line-strong hover:bg-paper',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        router.push('/admin/login');
        router.refresh();
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}

/** Page-wide polite live region for "Saved" style confirmations raised by dialogs. */
export function StatusRegion() {
  const [message, setMessage] = React.useState('');
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onStatus = (e: Event) => {
      setMessage(String((e as CustomEvent<string>).detail ?? ''));
      clearTimeout(timer);
      timer = setTimeout(() => setMessage(''), 8000);
    };
    window.addEventListener(STATUS_EVENT, onStatus);
    return () => {
      window.removeEventListener(STATUS_EVENT, onStatus);
      clearTimeout(timer);
    };
  }, []);
  return (
    <div aria-live="polite" role="status" className="mb-4 empty:hidden">
      {message && (
        <p className="border border-success-text bg-success-bg p-3 text-sm text-success-text">
          {message}
        </p>
      )}
    </div>
  );
}
