import Link from 'next/link';
import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/storefront/auth/auth-forms';
import { PageShell, PageTitle } from '@/storefront/shell';

export const metadata: Metadata = { title: 'Choose a new password | DOPAMEAN' };

type Props = { searchParams: Promise<{ token?: string; error?: string }> };

export default async function ResetPasswordPage({ searchParams }: Props) {
  const { token, error } = await searchParams;
  return (
    <PageShell>
      <div className="sp-narrow">
        <PageTitle>NEW PASSWORD</PageTitle>
        {token && !error ? (
          <ResetPasswordForm token={token} />
        ) : (
          <>
            <p role="alert" className="sp-message sp-message--error">
              This reset link is invalid or has expired.
            </p>
            <Link className="sp-link" href="/forgot-password">
              Request a new link
            </Link>
          </>
        )}
      </div>
    </PageShell>
  );
}
