import Link from 'next/link';
import type { Metadata } from 'next';
import { ResendVerificationForm } from '@/storefront/auth/auth-forms';
import { PageShell, PageTitle } from '@/storefront/shell';

export const metadata: Metadata = { title: 'Verify your email | DOPAMEAN' };

type Props = { searchParams: Promise<{ error?: string }> };

export default async function VerifyEmailPage({ searchParams }: Props) {
  const { error } = await searchParams;
  return (
    <PageShell>
      <div className="sp-narrow">
        <PageTitle>VERIFY YOUR EMAIL</PageTitle>
        {error && (
          <p role="alert" className="sp-message sp-message--error">
            That verification link is invalid or has expired. Request a new one below.
          </p>
        )}
        <p className="sp-text">
          Need a new verification link? Enter your email and we will send one.
        </p>
        <ResendVerificationForm />
        <p className="sp-text" style={{ marginTop: 18 }}>
          <Link className="sp-link" href="/login">
            Back to sign in
          </Link>
        </p>
      </div>
    </PageShell>
  );
}
