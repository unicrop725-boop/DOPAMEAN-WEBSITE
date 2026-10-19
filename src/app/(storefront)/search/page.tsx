import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { getFilterOptions, listProducts, parseListingQuery } from '@/modules/catalog';
import { ListingView } from '@/storefront/listing';

export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export const metadata: Metadata = {
  title: 'Search | DOPAMEAN',
  robots: { index: false, follow: true },
  icons: { icon: '/assets/Group 4.png' },
};

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const db = getDb();
  const rawQ = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  const query = parseListingQuery(sp, {
    defaultSort: rawQ?.trim() ? 'relevance' : 'newest',
    allowRelevance: true,
  });
  const scope = { kind: 'all' } as const;
  const [listing, options] = await Promise.all([
    query.q
      ? listProducts(db, scope, query)
      : Promise.resolve({ items: [], total: 0, page: 1, pageSize: query.pageSize, pageCount: 1 }),
    getFilterOptions(db, scope),
  ]);

  return (
    <ListingView
      heading="Search"
      basePath="/search"
      listing={listing}
      query={query}
      options={options}
      emptyMessage={
        query.q ? `NO PRODUCTS FOUND FOR "${query.q.toUpperCase()}".` : 'TYPE SOMETHING TO SEARCH.'
      }
      searchBar={
        <div className="sp-page" style={{ minHeight: 0, borderTop: 0, paddingBottom: 0 }}>
          <form className="sp-searchbar" method="get" action="/search" role="search">
            <label className="sp-skip" htmlFor="search-q">
              Search products
            </label>
            <input
              id="search-q"
              name="q"
              type="search"
              className="sp-input"
              defaultValue={query.q ?? ''}
              placeholder="SEARCH PRODUCTS"
              autoComplete="off"
            />
            <button className="sp-btn" type="submit">
              Search
            </button>
          </form>
          {query.q && (
            <p className="sp-result-count" role="status">
              {listing.total} result{listing.total === 1 ? '' : 's'} for &quot;{query.q}&quot;
            </p>
          )}
        </div>
      }
    />
  );
}
