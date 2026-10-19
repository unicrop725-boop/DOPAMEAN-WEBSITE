import Link from 'next/link';
import type { Metadata } from 'next';
import { requireUser } from '@/lib/session';
import { AccountShell } from '@/storefront/account-shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Orders | DOPAMEAN' };

// There is no way to place an order yet (checkout is the next build step), so no customer can have
// orders. This page is replaced by a real order-history query when the orders module lands.
export default async function OrdersPage() {
  await requireUser('/account/orders');
  return (
    <AccountShell current="/account/orders" title="MY ORDERS">
      <div className="sp-empty">
        <p className="sp-text" style={{ margin: '0 auto 14px' }}>
          You have not placed any orders yet.
        </p>
        <Link className="sp-btn" href="/collections/all">
          Shop now
        </Link>
      </div>
    </AccountShell>
  );
}
