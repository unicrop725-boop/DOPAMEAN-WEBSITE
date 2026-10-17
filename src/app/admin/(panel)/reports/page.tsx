import { getDb } from '@/db/client';
import { FilterBar, FilterInput } from '@/components/admin/filter-bar';
import { EmptyState, Forbidden, Metric, PageHeader, Rupees } from '@/components/admin/parts';
import { dateParam, gate, type SearchParams } from '@/lib/admin/page';
import { AppError } from '@/lib/errors';
import {
  REPORT_DEFINITIONS,
  istDayOf,
  istMonthStart,
  salesReport,
  type SalesReport,
} from '@/modules/orders';

export const metadata = { title: 'Sales report' };
export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('reports.view');
  if (!g.ok) return <Forbidden what="reports" reason={g.reason} />;
  const sp = await searchParams;
  const now = new Date();
  const from = dateParam(sp.from) ?? istMonthStart(now);
  const to = dateParam(sp.to) ?? istDayOf(now);

  let report: SalesReport | null = null;
  let error: string | null = null;
  try {
    report = await salesReport(getDb(), g.admin, { from, to });
  } catch (err) {
    if (err instanceof AppError && err.code === 'VALIDATION_FAILED') error = err.message;
    else throw err;
  }

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Sales report"
        description="Dates are calendar days in India time (IST). The default range is this month so far."
      />
      <FilterBar label="Report range" resetHref="/admin/reports">
        <FilterInput name="from" label="From" type="date" defaultValue={from} />
        <FilterInput name="to" label="To (inclusive)" type="date" defaultValue={to} />
      </FilterBar>

      {error && (
        <p role="alert" className="mb-4 border border-danger bg-danger-bg p-3 text-sm text-danger">
          {error}
        </p>
      )}

      {report && (
        <>
          <p className="mb-3 text-sm text-muted-text">
            {report.range.from} to {report.range.to}
          </p>
          {report.orderCount === 0 && report.refundsPaise === 0 ? (
            <EmptyState title="No sales in this range">
              No confirmed or completed orders were placed between these dates.
            </EmptyState>
          ) : null}
          <dl className="grid grid-cols-1 gap-px border border-line bg-line sm:grid-cols-2 xl:grid-cols-3">
            <Metric
              label="Gross sales"
              value={<Rupees paise={report.grossSalesPaise} />}
              definition={REPORT_DEFINITIONS.grossSales}
            />
            <Metric
              label="Refunds"
              value={<Rupees paise={report.refundsPaise} />}
              definition={REPORT_DEFINITIONS.refunds}
            />
            <Metric
              label="Net sales"
              value={<Rupees paise={report.netSalesPaise} />}
              definition={REPORT_DEFINITIONS.netSales}
            />
            <Metric
              label="Orders"
              value={report.orderCount}
              definition={REPORT_DEFINITIONS.orders}
            />
            <Metric
              label="Average order value"
              value={<Rupees paise={report.averageOrderValuePaise} />}
              definition={REPORT_DEFINITIONS.averageOrderValue}
            />
            <Metric
              label="Tax collected (GST)"
              value={<Rupees paise={report.taxCollectedPaise} />}
              definition={REPORT_DEFINITIONS.taxCollected}
            />
          </dl>

          <h2 className="admin-h2 mt-8">Online versus cash on delivery</h2>
          <p className="mb-2 text-sm text-muted-text">{REPORT_DEFINITIONS.split}</p>
          <div className="overflow-x-auto border border-line">
            <table className="admin-table">
              <caption className="sr-only">Orders and gross sales by payment method</caption>
              <thead>
                <tr>
                  <th scope="col">Payment method</th>
                  <th scope="col" className="num">
                    Orders
                  </th>
                  <th scope="col" className="num">
                    Gross sales
                  </th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Online (Razorpay)', report.split.online],
                    ['Cash on delivery', report.split.cod],
                  ] as const
                ).map(([label, row]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td className="num">{row.orderCount}</td>
                    <td className="num">
                      <Rupees paise={row.grossSalesPaise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-sm text-muted-text">
            {REPORT_DEFINITIONS.cancelledRefunds}{' '}
            <strong className="font-mono text-ink">
              <Rupees paise={report.cancelledRefundsPaise} />
            </strong>{' '}
            in this range.
          </p>
        </>
      )}
    </section>
  );
}
