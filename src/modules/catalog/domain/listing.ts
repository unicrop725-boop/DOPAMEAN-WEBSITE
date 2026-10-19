import { z } from 'zod';

/** URL-state parsing for product listings (filters, sort and pagination live in the URL). Pure. */
export const SORT_KEYS = [
  'featured',
  'newest',
  'price_asc',
  'price_desc',
  'name',
  'relevance',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABELS: Record<SortKey, string> = {
  featured: 'Featured',
  newest: 'Newest',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  name: 'Name',
  relevance: 'Relevance',
};

export const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'] as const;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 24;

export type ListingQuery = {
  q?: string;
  sizes: string[];
  minPaise?: number;
  maxPaise?: number;
  inStock: boolean;
  sort: SortKey;
  page: number;
  pageSize: number;
};

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;
const many = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

const rupeesToPaise = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return undefined;
  return Math.round(n * 100);
};

/**
 * Parse untrusted URL search params into a safe ListingQuery. Anything invalid falls back to a default
 * instead of throwing, and page size is always capped (no unbounded queries, brief §8).
 */
export function parseListingQuery(
  params: Record<string, string | string[] | undefined>,
  opts: { defaultSort: SortKey; allowRelevance?: boolean },
): ListingQuery {
  const rawQ = first(params.q)?.trim().slice(0, 100);
  const sortParsed = z.enum(SORT_KEYS).safeParse(first(params.sort));
  let sort: SortKey = sortParsed.success ? sortParsed.data : opts.defaultSort;
  if (sort === 'relevance' && !rawQ)
    sort = opts.defaultSort === 'relevance' ? 'newest' : opts.defaultSort;
  if (sort === 'relevance' && !opts.allowRelevance) sort = opts.defaultSort;

  const sizes = [...new Set(many(params.size).map((s) => s.toUpperCase()))].filter((s) =>
    (SIZE_ORDER as readonly string[]).includes(s),
  );

  const page = Math.max(1, Math.min(10_000, Number.parseInt(first(params.page) ?? '1', 10) || 1));
  const rawSize = Number.parseInt(first(params.pageSize) ?? '', 10);
  const pageSize = Number.isFinite(rawSize)
    ? Math.max(1, Math.min(MAX_PAGE_SIZE, rawSize))
    : DEFAULT_PAGE_SIZE;

  let minPaise = rupeesToPaise(first(params.min));
  let maxPaise = rupeesToPaise(first(params.max));
  if (minPaise !== undefined && maxPaise !== undefined && minPaise > maxPaise) {
    [minPaise, maxPaise] = [maxPaise, minPaise];
  }

  return {
    q: rawQ ? rawQ : undefined,
    sizes,
    minPaise,
    maxPaise,
    inStock: first(params.stock) === '1',
    sort,
    page,
    pageSize,
  };
}

/** Rebuild a URL query string from a ListingQuery plus overrides (for pagination / filter links). */
export function listingQueryString(
  q: ListingQuery,
  overrides: Partial<{ page: number; sort: SortKey }> = {},
): string {
  const sp = new URLSearchParams();
  if (q.q) sp.set('q', q.q);
  for (const s of q.sizes) sp.append('size', s);
  if (q.minPaise !== undefined) sp.set('min', String(q.minPaise / 100));
  if (q.maxPaise !== undefined) sp.set('max', String(q.maxPaise / 100));
  if (q.inStock) sp.set('stock', '1');
  const sort = overrides.sort ?? q.sort;
  sp.set('sort', sort);
  if (q.pageSize !== DEFAULT_PAGE_SIZE) sp.set('pageSize', String(q.pageSize));
  const page = overrides.page ?? q.page;
  if (page > 1) sp.set('page', String(page));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
