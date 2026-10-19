import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE_SIZE,
  listingQueryString,
  parseListingQuery,
} from '@/modules/catalog/domain/listing';

const base = { defaultSort: 'newest' as const };

describe('parseListingQuery (untrusted URL input)', () => {
  it('uses safe defaults for an empty query', () => {
    const q = parseListingQuery({}, base);
    expect(q).toMatchObject({ sizes: [], inStock: false, sort: 'newest', page: 1, pageSize: 24 });
    expect(q.q).toBeUndefined();
  });

  it('caps page size at the maximum and ignores nonsense', () => {
    expect(parseListingQuery({ pageSize: '100000' }, base).pageSize).toBe(MAX_PAGE_SIZE);
    expect(parseListingQuery({ pageSize: '-5' }, base).pageSize).toBe(1);
    expect(parseListingQuery({ pageSize: 'abc' }, base).pageSize).toBe(24);
  });

  it('clamps page numbers', () => {
    expect(parseListingQuery({ page: '0' }, base).page).toBe(1);
    expect(parseListingQuery({ page: '-3' }, base).page).toBe(1);
    expect(parseListingQuery({ page: 'x' }, base).page).toBe(1);
    expect(parseListingQuery({ page: '999999999' }, base).page).toBe(10_000);
  });

  it('only accepts known sort keys; relevance needs a query and permission', () => {
    expect(parseListingQuery({ sort: 'price_asc' }, base).sort).toBe('price_asc');
    expect(parseListingQuery({ sort: 'drop table' }, base).sort).toBe('newest');
    expect(parseListingQuery({ sort: 'relevance' }, base).sort).toBe('newest');
    expect(parseListingQuery({ sort: 'relevance', q: 'shirt' }, base).sort).toBe('newest');
    expect(
      parseListingQuery({ sort: 'relevance', q: 'shirt' }, { ...base, allowRelevance: true }).sort,
    ).toBe('relevance');
  });

  it('only accepts real sizes, de-duplicated and upper-cased', () => {
    const q = parseListingQuery({ size: ['m', 'M', 'XL', 'huge', "'; --"] }, base);
    expect(q.sizes).toEqual(['M', 'XL']);
  });

  it('parses price bounds in rupees to paise and swaps a reversed range', () => {
    expect(parseListingQuery({ min: '500', max: '1500' }, base)).toMatchObject({
      minPaise: 50_000,
      maxPaise: 150_000,
    });
    expect(parseListingQuery({ min: '2000', max: '100' }, base)).toMatchObject({
      minPaise: 10_000,
      maxPaise: 200_000,
    });
    expect(parseListingQuery({ min: '-1', max: 'abc' }, base)).toMatchObject({
      minPaise: undefined,
      maxPaise: undefined,
    });
  });

  it('trims and truncates the search text', () => {
    expect(parseListingQuery({ q: '  shirt  ' }, base).q).toBe('shirt');
    expect(parseListingQuery({ q: 'a'.repeat(500) }, base).q).toHaveLength(100);
    expect(parseListingQuery({ q: '   ' }, base).q).toBeUndefined();
  });

  it('round-trips through listingQueryString', () => {
    const q = parseListingQuery(
      {
        q: 'oxford',
        size: ['M', 'L'],
        min: '100',
        max: '900',
        stock: '1',
        sort: 'price_desc',
        page: '3',
      },
      { ...base, allowRelevance: true },
    );
    const again = parseListingQuery(
      Object.fromEntries(new URLSearchParams(listingQueryString(q)).entries()) as Record<
        string,
        string
      >,
      { ...base, allowRelevance: true },
    );
    expect(again.q).toBe('oxford');
    expect(again.minPaise).toBe(10_000);
    expect(again.inStock).toBe(true);
    expect(again.sort).toBe('price_desc');
    expect(again.page).toBe(3);
    expect(listingQueryString(q, { page: 1 })).not.toContain('page=');
  });
});
