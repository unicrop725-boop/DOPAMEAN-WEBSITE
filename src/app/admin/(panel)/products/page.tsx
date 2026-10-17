import Link from 'next/link';
import { getDb } from '@/db/client';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import {
  EmptyState,
  Forbidden,
  Notice,
  PageHeader,
  Pagination,
  ProductStatusBadge,
  Rupees,
  dateOnly,
} from '@/components/admin/parts';
import { Button } from '@/components/ui/button';
import { noticeText } from '@/lib/admin/notices';
import { enumParam, first, gate, intParam, queryString, type SearchParams } from '@/lib/admin/page';
import { listProductsAdmin, mediaUrl, PRODUCT_STATUSES } from '@/modules/catalog';

export const metadata = { title: 'Products' };
export const dynamic = 'force-dynamic';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('catalog.edit');
  if (!g.ok) return <Forbidden what="products" reason={g.reason} />;
  const sp = await searchParams;
  const q = first(sp.q)?.trim().slice(0, 100) || undefined;
  const status = enumParam(sp.status, PRODUCT_STATUSES);
  const pageSize = intParam(sp.pageSize, 25, 1, 100);
  const page = intParam(sp.page, 1, 1, 100_000);
  const list = await listProductsAdmin(getDb(), g.admin, { q, status, page, pageSize });
  const base = { q, status, pageSize: pageSize === 25 ? undefined : pageSize };
  const hrefFor = (p: number) =>
    `/admin/products${queryString({ ...base, page: p > 1 ? p : undefined })}`;
  const filtered = Boolean(q || status);

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Products"
        description="Search by name, URL slug or SKU."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/admin/products/categories">Categories and collections</Link>
            </Button>
            <Button asChild>
              <Link href="/admin/products/new">New product</Link>
            </Button>
          </>
        }
      />
      <Notice text={noticeText(sp.notice)} />
      <FilterBar label="Filter products" resetHref="/admin/products">
        <FilterInput
          name="q"
          label="Search"
          defaultValue={q}
          placeholder="Name, slug or SKU"
          className="min-w-56"
        />
        <FilterSelect
          name="status"
          label="Status"
          defaultValue={status}
          options={PRODUCT_STATUSES.map((s) => ({
            value: s,
            label: s[0]!.toUpperCase() + s.slice(1),
          }))}
        />
      </FilterBar>

      {list.items.length === 0 ? (
        <EmptyState title={filtered ? 'No products match these filters' : 'No products yet'}>
          {filtered ? (
            <Link href="/admin/products" className="admin-link">
              Clear the filters
            </Link>
          ) : (
            <Link href="/admin/products/new" className="admin-link">
              Create the first product
            </Link>
          )}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="admin-table">
            <caption className="sr-only">Products, most recently changed first</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Image</span>
                </th>
                <th scope="col">Product</th>
                <th scope="col">Status</th>
                <th scope="col">Category</th>
                <th scope="col" className="num">
                  Variants
                </th>
                <th scope="col" className="num">
                  Price
                </th>
                <th scope="col" className="num">
                  Available
                </th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((p) => (
                <tr key={p.id}>
                  <td className="w-14">
                    {p.imageKey ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaUrl(p.imageKey)}
                        alt={p.imageAlt}
                        width={40}
                        height={40}
                        className="size-10 border border-line object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span
                        className="flex size-10 items-center justify-center border border-dashed border-line-strong text-xs text-muted-text"
                        aria-label="No image"
                      >
                        --
                      </span>
                    )}
                  </td>
                  <th scope="row">
                    <Link href={`/admin/products/${p.id}`} className="admin-link">
                      {p.name}
                    </Link>
                    <span className="block font-mono text-xs font-normal text-muted-text">
                      /{p.slug}
                    </span>
                  </th>
                  <td>
                    <ProductStatusBadge status={p.status} />
                  </td>
                  <td>{p.categoryName ?? 'None'}</td>
                  <td className="num">{p.variantCount}</td>
                  <td className="num">
                    {p.minPricePaise === null ? (
                      'n/a'
                    ) : p.minPricePaise === p.maxPricePaise ? (
                      <Rupees paise={p.minPricePaise} />
                    ) : (
                      <>
                        <Rupees paise={p.minPricePaise} /> to{' '}
                        <Rupees paise={p.maxPricePaise ?? p.minPricePaise} />
                      </>
                    )}
                  </td>
                  <td className="num">{p.available}</td>
                  <td className="whitespace-nowrap">{dateOnly(p.updatedAt)}</td>
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
