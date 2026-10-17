import Link from 'next/link';
import { getDb } from '@/db/client';
import {
  Forbidden,
  FulfillmentBadge,
  Metric,
  OrderStatusBadge,
  PageHeader,
  PaymentBadge,
  Rupees,
  EmptyState,
  dateTime,
} from '@/components/admin/parts';
import { listOrdersPage } from '@/lib/admin/orders';
import { gate } from '@/lib/admin/page';
import { countLowStockVariants, countProductsByStatus } from '@/modules/catalog';
import {
  DASHBOARD_DEFINITIONS,
  dashboardMetrics,
  istDayOf,
  istMonthStart,
  salesReport,
} from '@/modules/orders';
import { can } from '@/modules/staff';

export const metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const g = await gate('orders.view');
  if (!g.ok) return <Forbidden what="the dashboard" reason={g.reason} />;
  const db = getDb();
  const now = new Date();
  const showSales = can(g.staff.role, 'reports.view');
  const [metrics, lowStock, products, recent, sales] = await Promise.all([
    dashboardMetrics(db, g.admin, now),
    countLowStockVariants(db, g.admin),
    countProductsByStatus(db),
    listOrdersPage(db, g.admin, { pageSize: 10 }),
    showSales
      ? salesReport(db, g.admin, { from: istMonthStart(now), to: istDayOf(now) })
      : Promise.resolve(null),
  ]);
  const s = metrics.ordersByStatus;

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Dashboard"
        description="Live numbers from the database. Each tile says what it counts."
      />
      <dl className="grid grid-cols-1 gap-px border border-line bg-line sm:grid-cols-2 xl:grid-cols-3">
        <Metric
          label="Orders today"
          value={metrics.ordersToday}
          definition={DASHBOARD_DEFINITIONS.ordersToday}
          href="/admin/orders?sort=newest"
        />
        <Metric
          label="Awaiting shipment"
          value={metrics.awaitingShipment}
          definition={DASHBOARD_DEFINITIONS.awaitingShipment}
          href="/admin/orders?status=confirmed&fulfillment=unfulfilled"
        />
        <Metric
          label="Awaiting COD collection"
          value={metrics.awaitingCodCollection}
          definition={DASHBOARD_DEFINITIONS.awaitingCod}
          href="/admin/orders?payment=cod&status=confirmed"
        />
        <Metric
          label="Published products"
          value={products.published}
          definition="Published products: products with status published, visible to customers in the shop."
        />
        <Metric
          label="Low-stock variants"
          value={lowStock}
          definition={DASHBOARD_DEFINITIONS.lowStock}
          href={can(g.staff.role, 'inventory.edit') ? '/admin/inventory?low=1' : undefined}
        />
        {sales && (
          <Metric
            label="Sales this month"
            value={<Rupees paise={sales.grossSalesPaise} />}
            definition={DASHBOARD_DEFINITIONS.salesThisMonth}
            href="/admin/reports"
          />
        )}
        <div className="bg-paper p-4">
          <dt>
            <span className="font-mono text-xs uppercase text-muted-text">Orders by status</span>
            <span className="mt-1 block text-xs text-muted-text">
              {DASHBOARD_DEFINITIONS.ordersByStatus}
            </span>
          </dt>
          <dd className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm tabular-nums">
            <Link className="admin-link" href="/admin/orders?status=pending_payment">
              Awaiting payment: {s.pending_payment}
            </Link>
            <Link className="admin-link" href="/admin/orders?status=confirmed">
              Confirmed: {s.confirmed}
            </Link>
            <Link className="admin-link" href="/admin/orders?status=completed">
              Completed: {s.completed}
            </Link>
            <Link className="admin-link" href="/admin/orders?status=cancelled">
              Cancelled: {s.cancelled}
            </Link>
          </dd>
        </div>
      </dl>

      <h2 className="admin-h2 mt-8">Recent orders</h2>
      {recent.items.length === 0 ? (
        <EmptyState title="No orders yet">
          Orders appear here as soon as customers place them.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="admin-table">
            <caption className="sr-only">The ten most recent orders</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Placed</th>
                <th scope="col">Customer</th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col">Payment</th>
                <th scope="col">Fulfilment</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.items.map(({ order: o, paymentStatus }) => (
                <tr key={o.id}>
                  <th scope="row">
                    <Link href={`/admin/orders/${o.id}`} className="admin-link">
                      #{o.number}
                    </Link>
                  </th>
                  <td>{dateTime(o.placedAt)}</td>
                  <td>{o.shippingAddress.fullName}</td>
                  <td className="num">
                    <Rupees paise={o.totalPaise} />
                  </td>
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
      <p className="mt-3 text-sm">
        <Link href="/admin/orders" className="admin-link">
          All orders
        </Link>
        {can(g.staff.role, 'inventory.edit') && (
          <>
            {' · '}
            <Link href="/admin/inventory" className="admin-link">
              Inventory
            </Link>
          </>
        )}
        {showSales && (
          <>
            {' · '}
            <Link href="/admin/reports" className="admin-link">
              Sales report
            </Link>
          </>
        )}
      </p>
    </section>
  );
}
