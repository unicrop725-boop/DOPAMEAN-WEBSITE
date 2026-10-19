import Link from 'next/link';
import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/storefront/auth/auth-forms';
import { PageShell, PageTitle } from '@/storefront/shell';

export const metadata: Metadata = { title: 'Reset password | DOPAMEAN' };

export default function ForgotPasswordPage() {
  return (
    <PageShell>
      <div className="sp-narrow">
        <PageTitle>RESET PASSWORD</PageTitle>
        <p className="sp-text">
          Enter your email and we will send you a link to choose a new password.
        </p>
        <ForgotPasswordForm />
        <p className="sp-text" style={{ marginTop: 18 }}>
          <Link className="sp-link" href="/login">
            Back to sign in
          </Link>
        </p>
      </div>
    </PageShell>
  );
}
