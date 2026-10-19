import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getSessionUser } from '@/lib/session';
import { RegisterForm } from '@/storefront/auth/auth-forms';
import { PageShell, PageTitle } from '@/storefront/shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Create account | DOPAMEAN' };

export default async function RegisterPage() {
  if (await getSessionUser()) redirect('/account');
  return (
    <PageShell>
      <div className="sp-narrow">
        <PageTitle>CREATE ACCOUNT</PageTitle>
        <RegisterForm />
        <p className="sp-text" style={{ marginTop: 18 }}>
          Already have an account?{' '}
          <Link className="sp-link" href="/login">
            Sign in
          </Link>
        </p>
      </div>
    </PageShell>
  );
}
