import Script from 'next/script';
import '@/styles/shop-pages.css';
import {
  SORT_KEYS,
  SORT_LABELS,
  listingQueryString,
  mediaUrl,
  type FilterOptions,
  type Listing,
  type ListingQuery,
  type ProductCard,
  type SortKey,
} from '@/modules/catalog';
import { Money, formatBracketPrice } from '@/modules/pricing';
import { SiteFooter } from './footer';
import { SiteHeader } from './header';

const COLUMNS = 4;

function priceLabel(card: ProductCard): string {
  const min = formatBracketPrice(Money.of(card.minPricePaise));
  return card.maxPricePaise > card.minPricePaise ? `FROM ${min}` : min;
}

export function ProductItem({ card }: { card: ProductCard }) {
  return (
    <a href={`/products/${card.slug}`}>
      <div className="product-item">
        <div className="image-container">
          {card.imageKey ? (
            <img
              className="product-image"
              src={mediaUrl(card.imageKey)}
              alt={card.imageAlt || card.name}
            />
          ) : (
            <div
              className="product-image"
              style={{ aspectRatio: '3 / 4', background: '#d8d8d8' }}
            />
          )}
        </div>
        <div className="product-info">
          <p className="product-name">{card.name.toUpperCase()}</p>
          <p className="product-price">
            {priceLabel(card)}
            {!card.inStock && ' SOLD OUT'}
          </p>
        </div>
      </div>
    </a>
  );
}

function Showcase({ row }: { row: ProductCard[] }) {
  return (
    <div className="product-showcase">
      <div className="product-grid">
        {row.map((card) => (
          <ProductItem key={card.id} card={card} />
        ))}
        {Array.from({ length: COLUMNS - row.length }, (_, k) => (
          <div key={`pad-${k}`} className="product-item" aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function FilterBar({
  basePath,
  query,
  options,
  sortOptions,
}: {
  basePath: string;
  query: ListingQuery;
  options: FilterOptions;
  sortOptions: SortKey[];
}) {
  return (
    <>
      <div className="filter-bar">
        <span
          role="button"
          tabIndex={0}
          aria-expanded="false"
          aria-controls="filter-panel"
          data-panel="filter-panel"
        >
          FILTER
        </span>
        <span
          role="button"
          tabIndex={0}
          aria-expanded="false"
          aria-controls="sort-panel"
          data-panel="sort-panel"
        >
          SORTED BY
        </span>
      </div>
      <div className="sp-panel" id="filter-panel">
        <form method="get" action={basePath} aria-label="Filter products">
          {query.q && <input type="hidden" name="q" value={query.q} />}
          <input type="hidden" name="sort" value={query.sort} />
          {options.sizes.length > 0 && (
            <fieldset className="sp-field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="sp-label">Size</legend>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {options.sizes.map((s) => (
                  <label key={s} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      name="size"
                      value={s}
                      defaultChecked={query.sizes.includes(s)}
                    />{' '}
                    {s}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="sp-field">
            <label htmlFor="min">Min price (RS.)</label>
            <input
              id="min"
              name="min"
              type="number"
              min="0"
              inputMode="numeric"
              className="sp-input"
              defaultValue={query.minPaise !== undefined ? query.minPaise / 100 : ''}
            />
          </div>
          <div className="sp-field">
            <label htmlFor="max">Max price (RS.)</label>
            <input
              id="max"
              name="max"
              type="number"
              min="0"
              inputMode="numeric"
              className="sp-input"
              defaultValue={query.maxPaise !== undefined ? query.maxPaise / 100 : ''}
            />
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', height: 40 }}>
            <input type="checkbox" name="stock" value="1" defaultChecked={query.inStock} /> In stock
            only
          </label>
          <button className="sp-btn" type="submit">
            Apply
          </button>
          <a
            className="sp-btn sp-btn--outline"
            href={query.q ? `${basePath}?q=${encodeURIComponent(query.q)}` : basePath}
          >
            Clear
          </a>
        </form>
      </div>
      <div className="sp-panel" id="sort-panel">
        <nav className="sp-sort-list" aria-label="Sort products">
          {sortOptions.map((s) => (
            <a
              key={s}
              href={`${basePath}${listingQueryString(query, { sort: s, page: 1 })}`}
              aria-current={s === query.sort ? 'true' : undefined}
            >
              {SORT_LABELS[s]}
            </a>
          ))}
        </nav>
      </div>
    </>
  );
}

function Pagination({
  basePath,
  listing,
  query,
}: {
  basePath: string;
  listing: Listing;
  query: ListingQuery;
}) {
  if (listing.pageCount <= 1) return null;
  const prev = listing.page > 1;
  const next = listing.page < listing.pageCount;
  const href = (page: number) => `${basePath}${listingQueryString(query, { page })}`;
  return (
    <nav className="sp-pagination" aria-label="Pagination">
      {prev ? (
        <a href={href(listing.page - 1)} rel="prev">
          Previous
        </a>
      ) : (
        <span aria-disabled="true">Previous</span>
      )}
      <span aria-current="page">
        Page {listing.page} of {listing.pageCount}
      </span>
      {next ? (
        <a href={href(listing.page + 1)} rel="next">
          Next
        </a>
      ) : (
        <span aria-disabled="true">Next</span>
      )}
    </nav>
  );
}

/**
 * Collection / search results in the original collection-page layout: the original grid markup
 * (four products per bordered block), with the FILTER and SORTED BY labels wired to real panels.
 */
export function ListingView({
  heading,
  basePath,
  listing,
  query,
  options,
  emptyMessage,
  searchBar,
}: {
  heading: string;
  basePath: string;
  listing: Listing;
  query: ListingQuery;
  options: FilterOptions;
  emptyMessage: string;
  searchBar?: React.ReactNode;
}) {
  const sortOptions = SORT_KEYS.filter((s) => s !== 'relevance' || query.q) as SortKey[];
  const rows = chunk(listing.items, COLUMNS);
  return (
    <>
      <link rel="stylesheet" href="/css/collection_page.css" precedence="storefront" />
      <link rel="stylesheet" href="/css/collection_page_responsive.css" precedence="storefront" />
      <a className="sp-skip" href="#results">
        Skip to results
      </a>
      <SiteHeader />
      <div className="main-content-area" id="results">
        <h1 className="sp-skip">{heading}</h1>
        {searchBar}
        <FilterBar basePath={basePath} query={query} options={options} sortOptions={sortOptions} />
        {listing.items.length === 0 ? (
          <div className="sp-page" style={{ borderTop: 0 }}>
            <div className="sp-empty">{emptyMessage}</div>
          </div>
        ) : (
          rows[0] && <Showcase row={rows[0]} />
        )}
      </div>
      {rows.slice(1).map((row) => (
        <div className="main-content-area" key={row[0]?.id}>
          <Showcase row={row} />
        </div>
      ))}
      <div className="main-content-area">
        <Pagination basePath={basePath} listing={listing} query={query} />
      </div>
      <SiteFooter />
      <Script src="/js/storefront.js" strategy="afterInteractive" />
    </>
  );
}
