import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { SignOutButton } from '@/storefront/auth/auth-forms';
import { AccountShell } from '@/storefront/account-shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Account | DOPAMEAN' };

type Props = { searchParams: Promise<{ verified?: string; error?: string }> };

export default async function AccountPage({ searchParams }: Props) {
  const sp = await searchParams;
  const user = await getSessionUser();
  if (!user) {
    // A failed email-verification link lands here without a session.
    redirect(sp.error ? '/verify-email?error=1' : '/login?next=%2Faccount');
  }
  return (
    <AccountShell current="/account" title="MY ACCOUNT">
      {sp.verified === '1' && (
        <p role="status" className="sp-message sp-message--success">
          Your email address is verified.
        </p>
      )}
      <div className="sp-box">
        <p className="sp-label sp-muted">Name</p>
        <p className="sp-text">{user.name}</p>
        <p className="sp-label sp-muted">Email</p>
        <p className="sp-text">{user.email}</p>
      </div>
      <div className="sp-actions" style={{ marginTop: 18 }}>
        <SignOutButton />
      </div>
    </AccountShell>
  );
}
