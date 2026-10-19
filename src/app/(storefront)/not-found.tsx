import Link from 'next/link';
import { PageShell, PageTitle } from '@/storefront/shell';

export const metadata = { title: 'Page not found | DOPAMEAN' };

export default function NotFound() {
  return (
    <PageShell>
      <div className="sp-narrow">
        <PageTitle>PAGE NOT FOUND</PageTitle>
        <p className="sp-text">We could not find the page you were looking for.</p>
        <div className="sp-actions">
          <Link className="sp-btn" href="/">
            Back to home
          </Link>
          <Link className="sp-btn sp-btn--outline" href="/collections/all">
            Shop all
          </Link>
        </div>
      </div>
    </PageShell>
  );
}
