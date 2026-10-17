import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import {
  EmptyState,
  Forbidden,
  FulfillmentBadge,
  OrderStatusBadge,
  PageHeader,
  Pagination,
  Rupees,
  dateOnly,
  dateTime,
} from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { gate, intParam, queryString, type SearchParams } from '@/lib/admin/page';
import { getCustomerAdmin, stateName } from '@/modules/customers';
import { listCustomerOrders } from '@/modules/orders';
import { can } from '@/modules/staff';

export const metadata = { title: 'Customer' };
export const dynamic = 'force-dynamic';

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('customers.view');
  if (!g.ok) return <Forbidden what="customers" reason={g.reason} />;
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const customer = await getCustomerAdmin(db, g.admin, id);
  if (!customer) notFound();
  const showOrders = can(g.staff.role, 'orders.view');
  const page = intParam(sp.page, 1, 1, 100_000);
  const orders = showOrders
    ? await listCustomerOrders(db, customer.userId, { page, pageSize: 10 })
    : null;
  const path = `/admin/customers/${customer.userId}`;

  return (
    <section aria-labelledby="page-title">
      <p className="mb-2 text-sm">
        <Link href="/admin/customers" className="admin-link">
          Customers
        </Link>{' '}
        / {customer.name}
      </p>
      <PageHeader
        title={customer.name}
        description={
          <>
            {customer.email} · joined {dateOnly(customer.createdAt)}
          </>
        }
        actions={
          customer.deletedAt ? (
            <Badge tone="muted">Account deleted</Badge>
          ) : customer.emailVerified ? (
            <Badge tone="success">Email verified</Badge>
          ) : (
            <Badge tone="warning">Email not verified</Badge>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="orders-h">
          <h2 id="orders-h" className="admin-h2">
            Orders
          </h2>
          {!orders ? (
            <p className="text-sm text-muted-text">Your role cannot view orders.</p>
          ) : orders.items.length === 0 ? (
            <EmptyState title="No orders yet">
              This customer has not placed an order with this account.
            </EmptyState>
          ) : (
            <>
              <div className="overflow-x-auto border border-line">
                <table className="admin-table">
                  <caption className="sr-only">Orders placed by {customer.name}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Placed</th>
                      <th scope="col" className="num">
                        Total
                      </th>
                      <th scope="col">Fulfilment</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.items.map((o) => (
                      <tr key={o.id}>
                        <th scope="row">
                          <Link href={`/admin/orders/${o.id}`} className="admin-link">
                            #{o.number}
                          </Link>
                        </th>
                        <td className="whitespace-nowrap">{dateTime(o.placedAt)}</td>
                        <td className="num">
                          <Rupees paise={o.totalPaise} />
                        </td>
                        <td>
                          <FulfillmentBadge status={o.fulfillmentStatus} />
                        </td>
                        <td>
                          <OrderStatusBadge status={o.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={orders.page}
                pageCount={orders.pageCount}
                total={orders.total}
                pageSize={orders.pageSize}
                hrefFor={(p) => `${path}${queryString({ page: p > 1 ? p : undefined })}`}
              />
            </>
          )}
        </section>

        <aside className="flex flex-col gap-4" aria-label="Contact and addresses">
          <section className="admin-card" aria-labelledby="contact-h">
            <h2 id="contact-h" className="admin-h2">
              Contact
            </h2>
            <p className="text-sm">
              <a className="admin-link" href={`mailto:${customer.email}`}>
                {customer.email}
              </a>
              <br />
              {customer.phone ?? 'No phone saved'}
              <br />
              <span className="text-xs text-muted-text">
                Marketing emails: {customer.marketingOptIn ? 'opted in' : 'not opted in'}
              </span>
            </p>
          </section>
          <section className="admin-card" aria-labelledby="addr-h">
            <h2 id="addr-h" className="admin-h2">
              Saved addresses
            </h2>
            {customer.addresses.length === 0 ? (
              <p className="text-sm text-muted-text">No saved addresses.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {customer.addresses.map((a) => (
                  <li key={a.id}>
                    <address className="text-sm not-italic">
                      <strong>{a.fullName}</strong>{' '}
                      {a.isDefault && <Badge tone="muted">Default</Badge>}
                      <br />
                      {a.line1}
                      {a.line2 ? `, ${a.line2}` : ''}
                      <br />
                      {a.city}, {stateName(a.stateCode) ?? a.stateCode} {a.pincode}
                      <br />
                      {a.phone}
                    </address>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
