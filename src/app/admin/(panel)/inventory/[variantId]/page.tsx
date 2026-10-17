import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { ActionForm, Field, FormMessage, SubmitButton } from '@/components/admin/forms';
import { EmptyState, Forbidden, PageHeader, Pagination, dateTime } from '@/components/admin/parts';
import { gate, intParam, queryString, type SearchParams } from '@/lib/admin/page';
import { getVariantAdmin } from '@/modules/catalog';
import { listMovementsAdmin } from '@/modules/inventory';
import { lookupStaff } from '@/modules/staff';
import { adjustStockAction } from '../../products/actions';

export const metadata = { title: 'Stock history' };
export const dynamic = 'force-dynamic';

const REASONS: Record<string, string> = {
  initial: 'Opening stock',
  adjustment: 'Adjustment',
  sale: 'Sale',
  reservation_release: 'Reservation released',
  cancellation_restock: 'Cancelled order restocked',
  refund_restock: 'Refund restocked',
  correction: 'Correction',
};

export default async function VariantStockPage({
  params,
  searchParams,
}: {
  params: Promise<{ variantId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('inventory.edit');
  if (!g.ok) return <Forbidden what="inventory" reason={g.reason} />;
  const { variantId } = await params;
  const sp = await searchParams;
  const db = getDb();
  const variant = await getVariantAdmin(db, g.admin, variantId);
  if (!variant) notFound();
  const page = intParam(sp.page, 1, 1, 100_000);
  const moves = await listMovementsAdmin(db, g.admin, variantId, { page, pageSize: 25 });
  const people = await lookupStaff(
    db,
    moves.items.map((m) => m.actorUserId ?? ''),
  );
  const path = `/admin/inventory/${variantId}`;

  return (
    <section aria-labelledby="page-title">
      <p className="mb-2 text-sm">
        <Link href="/admin/inventory" className="admin-link">
          Inventory
        </Link>{' '}
        / {variant.sku}
      </p>
      <PageHeader
        title={`${variant.productName} · ${variant.sku}`}
        description={`${variant.onHand} on hand, ${variant.reserved} reserved, ${variant.available} available. Low-stock threshold ${variant.threshold}.`}
        actions={
          <Link href={`/admin/products/${variant.productId}`} className="admin-link text-sm">
            Open the product
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <ActionForm
          action={adjustStockAction.bind(null, variantId, path)}
          className="admin-card self-start"
          aria-label="Adjust stock"
        >
          <h2 className="admin-h2">Adjust stock</h2>
          <Field
            name="delta"
            label="Change (+ adds, - removes)"
            inputMode="numeric"
            required
            placeholder="-2 or 10"
          />
          <Field
            name="reason"
            label="Type"
            kind="select"
            defaultValue="adjustment"
            options={[
              { value: 'adjustment', label: 'Adjustment (restock, shrinkage)' },
              { value: 'correction', label: 'Correction (count was wrong)' },
            ]}
          />
          <Field
            name="note"
            label="Reason"
            required
            maxLength={300}
            hint={`On hand cannot go below the ${variant.reserved} reserved for unpaid orders.`}
          />
          <div className="flex items-center gap-3">
            <SubmitButton pendingLabel="Applying">Apply change</SubmitButton>
            <FormMessage />
          </div>
        </ActionForm>

        <div>
          <h2 className="admin-h2">Movement history</h2>
          {moves.items.length === 0 ? (
            <EmptyState title="No movements yet" />
          ) : (
            <div className="overflow-x-auto border border-line">
              <table className="admin-table">
                <caption className="sr-only">Stock movements, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">
                      Change
                    </th>
                    <th scope="col" className="num">
                      Before to after
                    </th>
                    <th scope="col">By</th>
                    <th scope="col">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.items.map((m) => (
                    <tr key={m.id}>
                      <td className="whitespace-nowrap">{dateTime(m.createdAt)}</td>
                      <td>{REASONS[m.reason] ?? m.reason}</td>
                      <td className="num">{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                      <td className="num">
                        {m.onHandBefore} to {m.onHandAfter}
                      </td>
                      <td className="text-xs">
                        {m.actorUserId
                          ? (people.get(m.actorUserId)?.email ?? 'removed user')
                          : 'system'}
                      </td>
                      <td className="text-xs">
                        {m.note ?? ''}
                        {m.refType && (
                          <span className="block text-muted-text">
                            {m.refType} {m.refId}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            page={moves.page}
            pageCount={moves.pageCount}
            total={moves.total}
            pageSize={moves.pageSize}
            hrefFor={(p) => `${path}${queryString({ page: p > 1 ? p : undefined })}`}
          />
        </div>
      </div>
    </section>
  );
}
