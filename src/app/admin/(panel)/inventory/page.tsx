import Link from 'next/link';
import { getDb } from '@/db/client';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { Field } from '@/components/admin/forms';
import { FilterBar, FilterInput } from '@/components/admin/filter-bar';
import { EmptyState, Forbidden, PageHeader, Pagination } from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { first, gate, intParam, queryString, type SearchParams } from '@/lib/admin/page';
import { listInventoryAdmin } from '@/modules/catalog';
import { adjustStockAction } from '../products/actions';

export const metadata = { title: 'Inventory' };
export const dynamic = 'force-dynamic';

const options = (v: Record<string, string>) => Object.values(v).join(' / ') || 'No options';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('inventory.edit');
  if (!g.ok) return <Forbidden what="inventory" reason={g.reason} />;
  const sp = await searchParams;
  const q = first(sp.q)?.trim().slice(0, 100) || undefined;
  const lowOnly = first(sp.low) === '1';
  const pageSize = intParam(sp.pageSize, 50, 1, 100);
  const page = intParam(sp.page, 1, 1, 100_000);
  const list = await listInventoryAdmin(getDb(), g.admin, { q, lowOnly, page, pageSize });
  const base = {
    q,
    low: lowOnly ? '1' : undefined,
    pageSize: pageSize === 50 ? undefined : pageSize,
  };
  const hrefFor = (p: number) =>
    `/admin/inventory${queryString({ ...base, page: p > 1 ? p : undefined })}`;

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Inventory"
        description="Available is on hand minus units reserved for unpaid orders. A variant is low when available is at or below its threshold."
      />
      <FilterBar label="Filter inventory" resetHref="/admin/inventory">
        <FilterInput
          name="q"
          label="Search"
          defaultValue={q}
          placeholder="Product or SKU"
          className="min-w-56"
        />
        <div className="flex items-center gap-2 self-end pb-2">
          <input
            id="f-low"
            name="low"
            type="checkbox"
            value="1"
            defaultChecked={lowOnly}
            className="size-5 accent-ink"
          />
          <label htmlFor="f-low" className="text-sm">
            Low stock only
          </label>
        </div>
      </FilterBar>

      {list.items.length === 0 ? (
        <EmptyState title={q || lowOnly ? 'No variants match these filters' : 'No variants yet'}>
          {q || lowOnly ? (
            <Link href="/admin/inventory" className="admin-link">
              Clear the filters
            </Link>
          ) : (
            'Create a product to start tracking stock.'
          )}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="admin-table">
            <caption className="sr-only">Stock by variant</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">SKU</th>
                <th scope="col">Options</th>
                <th scope="col" className="num">
                  On hand
                </th>
                <th scope="col" className="num">
                  Reserved
                </th>
                <th scope="col" className="num">
                  Available
                </th>
                <th scope="col" className="num">
                  Threshold
                </th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((v) => (
                <tr key={v.variantId}>
                  <th scope="row">
                    <Link href={`/admin/products/${v.productId}`} className="admin-link">
                      {v.productName}
                    </Link>
                  </th>
                  <td className="font-mono text-xs">{v.sku}</td>
                  <td>{options(v.optionValues)}</td>
                  <td className="num">{v.onHand}</td>
                  <td className="num">{v.reserved}</td>
                  <td className="num">{v.available}</td>
                  <td className="num">{v.threshold}</td>
                  <td>
                    {!v.active ? (
                      <Badge tone="muted">Inactive</Badge>
                    ) : v.available <= 0 ? (
                      <Badge tone="danger">Out of stock</Badge>
                    ) : v.low ? (
                      <Badge tone="warning">Low</Badge>
                    ) : (
                      <Badge tone="success">OK</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    <div className="flex gap-2">
                      <ConfirmAction
                        action={adjustStockAction.bind(null, v.variantId, '/admin/inventory')}
                        trigger="Adjust"
                        triggerLabel={`Adjust stock for ${v.sku}`}
                        title={`Adjust stock for ${v.sku}`}
                        description={`${v.productName}: ${v.onHand} on hand, ${v.reserved} reserved. Enter how many units to add (positive) or remove (negative). The change is saved in the stock history with your name and reason. On hand cannot go below the ${v.reserved} reserved.`}
                        confirmLabel="Apply change"
                        pendingLabel="Applying"
                      >
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
                        <Field name="note" label="Reason" required maxLength={300} />
                      </ConfirmAction>
                      <Link
                        href={`/admin/inventory/${v.variantId}`}
                        className="admin-link self-center text-sm"
                        aria-label={`Stock history for ${v.sku}`}
                      >
                        History
                      </Link>
                    </div>
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
