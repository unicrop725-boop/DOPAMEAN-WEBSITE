import type { Metadata } from 'next';
import { requireUser } from '@/lib/session';
import { AccountShell } from '@/storefront/account-shell';
import { DeleteAccountForm } from '@/storefront/delete-account-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Privacy | DOPAMEAN' };

export default async function PrivacyPage() {
  await requireUser('/account/privacy');
  return (
    <AccountShell current="/account/privacy" title="PRIVACY">
      <h2 className="sp-subtitle">Download your data</h2>
      <p className="sp-text">Get a copy of the personal data we hold about you as a JSON file.</p>
      <a className="sp-btn" href="/account/privacy/export" download>
        Download my data
      </a>

      <h2 className="sp-subtitle">Delete your account</h2>
      <p className="sp-text">
        This signs you out everywhere and permanently removes your sign-in, saved addresses and
        phone number. Records we are legally required to keep, such as tax invoices for past orders,
        are retained without your personal details being linked to a login.
      </p>
      <DeleteAccountForm />
    </AccountShell>
  );
}
