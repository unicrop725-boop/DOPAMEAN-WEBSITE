import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { safeNext } from '@/lib/safe-redirect';
import { getSessionUser } from '@/lib/session';
import { LoginForm } from '@/storefront/auth/auth-forms';
import { PageShell, PageTitle } from '@/storefront/shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in | DOPAMEAN' };

type Props = { searchParams: Promise<{ next?: string; reset?: string; error?: string }> };

export default async function LoginPage({ searchParams }: Props) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (await getSessionUser()) redirect(next);

  return (
    <PageShell>
      <div className="sp-narrow">
        <PageTitle>SIGN IN</PageTitle>
        {sp.reset === '1' && (
          <p role="status" className="sp-message sp-message--success">
            Password updated. Sign in with your new password.
          </p>
        )}
        {sp.error && (
          <p role="alert" className="sp-message sp-message--error">
            That link is invalid or has expired.
          </p>
        )}
        <LoginForm next={next} />
        <p className="sp-text" style={{ marginTop: 18 }}>
          <Link className="sp-link" href="/forgot-password">
            Forgot your password?
          </Link>
        </p>
        <p className="sp-text">
          New here?{' '}
          <Link className="sp-link" href="/register">
            Create an account
          </Link>
        </p>
      </div>
    </PageShell>
  );
}
