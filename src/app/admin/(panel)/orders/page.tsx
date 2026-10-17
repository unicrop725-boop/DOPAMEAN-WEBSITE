import Link from 'next/link';
import { getDb } from '@/db/client';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import {
  EmptyState,
  Forbidden,
  FulfillmentBadge,
  OrderStatusBadge,
  PageHeader,
  PaymentBadge,
  Pagination,
  Rupees,
  dateTime,
} from '@/components/admin/parts';
import { listOrdersPage } from '@/lib/admin/orders';
import { enumParam, first, gate, intParam, queryString, type SearchParams } from '@/lib/admin/page';

export const metadata = { title: 'Orders' };
export const dynamic = 'force-dynamic';

const STATUSES = ['pending_payment', 'confirmed', 'completed', 'cancelled'] as const;
const FULFILLMENTS = ['unfulfilled', 'shipped', 'delivered'] as const;
const METHODS = ['online', 'cod'] as const;
const SORTS = ['newest', 'oldest', 'total_desc', 'total_asc'] as const;
const PAGE_SIZES = [25, 50, 100];

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('orders.view');
  if (!g.ok) return <Forbidden what="orders" reason={g.reason} />;
  const sp = await searchParams;
  const q = first(sp.q)?.trim().slice(0, 100) || undefined;
  const status = enumParam(sp.status, STATUSES);
  const fulfillment = enumParam(sp.fulfillment, FULFILLMENTS);
  const paymentMethod = enumParam(sp.payment, METHODS);
  const sort = enumParam(sp.sort, SORTS) ?? 'newest';
  const pageSize = intParam(sp.pageSize, 25, 1, 100);
  const page = intParam(sp.page, 1, 1, 100_000);

  const list = await listOrdersPage(getDb(), g.admin, {
    q,
    status,
    fulfillment,
    paymentMethod,
    sort,
    page,
    pageSize,
  });
  const base = {
    q,
    status,
    fulfillment,
    payment: paymentMethod,
    sort: sort === 'newest' ? undefined : sort,
    pageSize: pageSize === 25 ? undefined : pageSize,
  };
  const hrefFor = (p: number) =>
    `/admin/orders${queryString({ ...base, page: p > 1 ? p : undefined })}`;
  const filtered = Boolean(q || status || fulfillment || paymentMethod);

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Orders"
        description="Search by order number, email, phone or customer name. Filters, sort and page are kept in the URL."
      />
      <FilterBar label="Filter orders" resetHref="/admin/orders">
        <FilterInput
          name="q"
          label="Search"
          defaultValue={q}
          placeholder="#1001, email, phone, name"
          className="min-w-56"
        />
        <FilterSelect
          name="status"
          label="Status"
          defaultValue={status}
          options={[
            { value: 'pending_payment', label: 'Awaiting payment' },
            { value: 'confirmed', label: 'Confirmed' },
            { value: 'completed', label: 'Completed' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />
        <FilterSelect
          name="fulfillment"
          label="Fulfilment"
          defaultValue={fulfillment}
          options={[
            { value: 'unfulfilled', label: 'Unfulfilled' },
            { value: 'shipped', label: 'Shipped' },
            { value: 'delivered', label: 'Delivered' },
          ]}
        />
        <FilterSelect
          name="payment"
          label="Payment method"
          defaultValue={paymentMethod}
          options={[
            { value: 'online', label: 'Online' },
            { value: 'cod', label: 'Cash on delivery' },
          ]}
        />
        <FilterSelect
          name="sort"
          label="Sort"
          defaultValue={sort}
          allLabel="Newest first"
          options={[
            { value: 'oldest', label: 'Oldest first' },
            { value: 'total_desc', label: 'Total: high to low' },
            { value: 'total_asc', label: 'Total: low to high' },
          ]}
        />
        <FilterSelect
          name="pageSize"
          label="Per page"
          defaultValue={String(pageSize)}
          allLabel="25"
          options={PAGE_SIZES.filter((n) => n !== 25).map((n) => ({
            value: String(n),
            label: String(n),
          }))}
        />
      </FilterBar>

      {list.items.length === 0 ? (
        <EmptyState title={filtered ? 'No orders match these filters' : 'No orders yet'}>
          {filtered ? (
            <Link href="/admin/orders" className="admin-link">
              Clear the filters
            </Link>
          ) : (
            'Orders appear here as soon as customers place them.'
          )}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="admin-table">
            <caption className="sr-only">Orders, newest first unless sorted otherwise</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Placed</th>
                <th scope="col">Customer</th>
                <th scope="col" className="num">
                  Items
                </th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col">Method</th>
                <th scope="col">Payment</th>
                <th scope="col">Fulfilment</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map(({ order: o, paymentStatus, itemCount }) => (
                <tr key={o.id}>
                  <th scope="row">
                    <Link href={`/admin/orders/${o.id}`} className="admin-link">
                      #{o.number}
                    </Link>
                  </th>
                  <td className="whitespace-nowrap">{dateTime(o.placedAt)}</td>
                  <td>
                    {o.shippingAddress.fullName}
                    <span className="block text-xs text-muted-text">{o.email}</span>
                  </td>
                  <td className="num">{itemCount}</td>
                  <td className="num">
                    <Rupees paise={o.totalPaise} />
                  </td>
                  <td>{o.paymentMethod === 'cod' ? 'COD' : 'Online'}</td>
                  <td>
                    <PaymentBadge status={paymentStatus} />
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
      )}
      <Pagination
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
        pageSize={list.pageSize}
        hrefFor={hrefFor}
      />
    </section>
  );
}
