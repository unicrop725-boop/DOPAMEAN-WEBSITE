import Link from 'next/link';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { STATUS_LABEL } from '@/lib/order-page';
import { requireUser } from '@/lib/session';
import { listCustomerOrders } from '@/modules/orders';
import { listPaymentsByOrderIds } from '@/modules/payments';
import { Money, formatBracketPrice } from '@/modules/pricing';
import { AccountShell } from '@/storefront/account-shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Orders | DOPAMEAN' };

type Props = { searchParams: Promise<{ page?: string }> };

export default async function OrdersPage({ searchParams }: Props) {
  const user = await requireUser('/account/orders');
  const page = Math.max(1, Number.parseInt((await searchParams).page ?? '1', 10) || 1);
  const db = getDb();
  const list = await listCustomerOrders(db, user.id, { page, pageSize: 20 });
  const payments = await listPaymentsByOrderIds(
    db,
    list.items.map((o) => o.id),
  );

  return (
    <AccountShell current="/account/orders" title="MY ORDERS">
      {list.items.length === 0 ? (
        <div className="sp-empty">
          <p className="sp-text" style={{ margin: '0 auto 14px' }}>
            You have not placed any orders yet.
          </p>
          <Link className="sp-btn" href="/collections/all">
            Shop now
          </Link>
        </div>
      ) : (
        <>
          <table className="sp-table">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Date</th>
                <th scope="col">Status</th>
                <th scope="col">Payment</th>
                <th scope="col" className="num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((o) => (
                <tr key={o.id}>
                  <th scope="row">
                    <Link className="sp-link" href={`/account/orders/${o.publicId}`}>
                      #{o.number}
                    </Link>
                  </th>
                  <td>
                    {o.placedAt.toLocaleDateString('en-IN', {
                      dateStyle: 'medium',
                      timeZone: 'Asia/Kolkata',
                    })}
                  </td>
                  <td>
                    {STATUS_LABEL[o.status]}
                    {o.fulfillmentStatus !== 'unfulfilled' &&
                      `, ${STATUS_LABEL[o.fulfillmentStatus]}`}
                  </td>
                  <td>{payments.get(o.id) ? STATUS_LABEL[payments.get(o.id)!.status] : '-'}</td>
                  <td className="num">{formatBracketPrice(Money.of(o.totalPaise))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.pageCount > 1 && (
            <nav className="sp-pagination" aria-label="Pagination" style={{ border: 0 }}>
              {page > 1 ? (
                <Link href={`/account/orders?page=${page - 1}`}>Previous</Link>
              ) : (
                <span aria-disabled="true">Previous</span>
              )}
              <span aria-current="page">
                Page {page} of {list.pageCount}
              </span>
              {page < list.pageCount ? (
                <Link href={`/account/orders?page=${page + 1}`}>Next</Link>
              ) : (
                <span aria-disabled="true">Next</span>
              )}
            </nav>
          )}
        </>
      )}
    </AccountShell>
  );
}
