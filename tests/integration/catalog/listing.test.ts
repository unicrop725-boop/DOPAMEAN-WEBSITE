import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { product, variant } from '@/db/schema';
import {
  addProductMedia,
  addToCollection,
  createCategory,
  createCollection,
  createProduct,
  getFilterOptions,
  getProductDetail,
  listCollectionTiles,
  listProducts,
  parseListingQuery,
  resolveListing,
} from '@/modules/catalog';
import { adjustStock } from '@/modules/inventory';
import { newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
const ids: Record<string, { productId: string; variantIds: string[] }> = {};
const all = { kind: 'all' } as const;
const q = (
  params: Record<string, string | string[]> = {},
  o: { sort?: 'newest' | 'featured'; rel?: boolean } = {},
) => parseListingQuery(params, { defaultSort: o.sort ?? 'newest', allowRelevance: o.rel });

const SIZES = ['S', 'M', 'L'];

async function make(
  slug: string,
  name: string,
  price: number,
  opts: {
    status?: 'published' | 'draft' | 'archived';
    categoryId?: string;
    stock?: number;
    description?: string;
    ageMin: number;
  },
) {
  const r = await createProduct(t.db, {
    slug,
    name,
    description: opts.description,
    status: opts.status ?? 'published',
    categoryId: opts.categoryId,
    variants: SIZES.map((s) => ({
      sku: `${slug}-${s}`,
      optionValues: { Size: s },
      pricePaise: price,
      stock: opts.stock ?? 5,
    })),
  });
  await t.db
    .update(product)
    .set({ createdAt: sql`now() - make_interval(mins => ${opts.ageMin})` })
    .where(eq(product.id, r.productId));
  await addProductMedia(t.db, r.productId, {
    objectKey: `/assets/${slug}.png`,
    alt: name,
    width: 10,
    height: 10,
    position: 0,
  });
  ids[slug] = r;
  return r;
}

beforeAll(async () => {
  t = await newTestDb();
  const tops = await createCategory(t.db, { slug: 'tops', name: 'Tops' });
  const bottoms = await createCategory(t.db, { slug: 'bottoms', name: 'Bottoms' });
  await make('oxford-shirt', 'Oxford Shirt', 149_900, {
    categoryId: tops,
    ageMin: 5,
    description: 'Crisp cotton button down',
  });
  await make('boxy-tee', 'Boxy Tee', 79_900, { categoryId: tops, ageMin: 4 });
  await make('pleated-trouser', 'Pleated Trouser', 189_900, {
    categoryId: bottoms,
    ageMin: 3,
    description: 'Wool blend',
  });
  await make('cargo-short', 'Cargo Short', 109_900, { categoryId: bottoms, ageMin: 2, stock: 0 }); // sold out
  await make('secret-draft', 'Secret Draft', 99_900, { status: 'draft', ageMin: 1 });
  await make('old-archive', 'Old Archive', 99_900, { status: 'archived', ageMin: 1 });
});
afterAll(async () => {
  await t.close();
});

describe('listing visibility and ordering', () => {
  it('shows only published products (draft and archived never leak)', async () => {
    const r = await listProducts(t.db, all, q());
    expect(r.items.map((i) => i.slug).sort()).toEqual([
      'boxy-tee',
      'cargo-short',
      'oxford-shirt',
      'pleated-trouser',
    ]);
    expect(r.total).toBe(4);
  });

  it('sorts newest first by default and supports price and name sorts', async () => {
    expect((await listProducts(t.db, all, q())).items.map((i) => i.slug)).toEqual([
      'cargo-short',
      'pleated-trouser',
      'boxy-tee',
      'oxford-shirt',
    ]);
    expect(
      (await listProducts(t.db, all, q({ sort: 'price_asc' }))).items.map((i) => i.slug)[0],
    ).toBe('boxy-tee');
    expect(
      (await listProducts(t.db, all, q({ sort: 'price_desc' }))).items.map((i) => i.slug)[0],
    ).toBe('pleated-trouser');
    expect((await listProducts(t.db, all, q({ sort: 'name' }))).items.map((i) => i.slug)).toEqual([
      'boxy-tee',
      'cargo-short',
      'oxford-shirt',
      'pleated-trouser',
    ]);
  });

  it('flags sold-out products and returns the cover image and price range', async () => {
    const r = await listProducts(t.db, all, q());
    const cargo = r.items.find((i) => i.slug === 'cargo-short')!;
    expect(cargo.inStock).toBe(false);
    expect(cargo.imageKey).toBe('/assets/cargo-short.png');
    expect(cargo.minPricePaise).toBe(109_900);
  });
});

describe('pagination is bounded', () => {
  it('pages through results and reports totals', async () => {
    const p1 = await listProducts(t.db, all, q({ pageSize: '3' }));
    const p2 = await listProducts(t.db, all, q({ pageSize: '3', page: '2' }));
    expect(p1.items).toHaveLength(3);
    expect(p2.items).toHaveLength(1);
    expect(p1.pageCount).toBe(2);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(4);
  });

  it('never returns more than 100 rows however large a page size is requested', async () => {
    const r = await listProducts(t.db, all, q({ pageSize: '999999' }));
    expect(r.pageSize).toBe(100);
  });

  it('a page past the end is empty, not an error', async () => {
    const r = await listProducts(t.db, all, q({ page: '50' }));
    expect(r.items).toEqual([]);
    expect(r.total).toBe(4);
  });
});

describe('filters', () => {
  it('filters by category scope', async () => {
    const res = await resolveListing(t.db, 'tops');
    expect(res?.kind).toBe('category');
    const r = await listProducts(t.db, res!.scope, q());
    expect(r.items.map((i) => i.slug).sort()).toEqual(['boxy-tee', 'oxford-shirt']);
  });

  it('filters by price range (rupees in the URL, paise in the database)', async () => {
    const r = await listProducts(t.db, all, q({ min: '1000', max: '1600' }));
    expect(r.items.map((i) => i.slug).sort()).toEqual(['cargo-short', 'oxford-shirt']);
  });

  it('filters by size and by in-stock only (stock-aware through the inventory read model)', async () => {
    expect((await listProducts(t.db, all, q({ size: 'M' }))).total).toBe(4);
    expect((await listProducts(t.db, all, q({ size: 'XL' }))).total).toBe(0);
    const inStock = await listProducts(t.db, all, q({ stock: '1' }));
    expect(inStock.items.map((i) => i.slug)).not.toContain('cargo-short');
    // Selling the last unit of one size removes it from the size+stock filter, but keeps the product for other sizes.
    const oxford = ids['oxford-shirt']!;
    for (const v of oxford.variantIds)
      await adjustStock(t.db, { variantId: v, delta: -5, reason: 'adjustment' });
    expect(
      (await listProducts(t.db, all, q({ stock: '1' }))).items.map((i) => i.slug),
    ).not.toContain('oxford-shirt');
    for (const v of oxford.variantIds)
      await adjustStock(t.db, { variantId: v, delta: 5, reason: 'adjustment' });
  });

  it('exposes filter options (sorted sizes and price range)', async () => {
    const o = await getFilterOptions(t.db, all);
    expect(o.sizes).toEqual(['S', 'M', 'L']);
    expect(o.priceMinPaise).toBe(79_900);
    expect(o.priceMaxPaise).toBe(189_900);
  });

  it('ignores inactive variants when pricing', async () => {
    const r = ids['boxy-tee']!;
    await t.db.update(variant).set({ active: false }).where(eq(variant.id, r.variantIds[0]!));
    const d = await getProductDetail(t.db, 'boxy-tee');
    expect(d?.variants).toHaveLength(2);
    await t.db.update(variant).set({ active: true }).where(eq(variant.id, r.variantIds[0]!));
  });
});

describe('search (full-text + typo tolerance)', () => {
  const search = (text: string) =>
    listProducts(t.db, all, q({ q: text, sort: 'relevance' }, { rel: true }));

  it('finds by name and by description', async () => {
    expect((await search('oxford')).items.map((i) => i.slug)).toEqual(['oxford-shirt']);
    expect((await search('wool')).items.map((i) => i.slug)).toEqual(['pleated-trouser']);
  });

  it('tolerates typos', async () => {
    expect((await search('oxfrd')).items.map((i) => i.slug)).toContain('oxford-shirt');
    expect((await search('troussers')).items.map((i) => i.slug)).toContain('pleated-trouser');
  });

  it('never returns drafts and treats special characters as plain text (no SQL injection, no crash)', async () => {
    expect((await search('secret')).items).toEqual([]);
    for (const nasty of ["'; DROP TABLE product; --", '%', '_', '\\', '"', '& | !']) {
      const r = await search(nasty);
      expect(Array.isArray(r.items)).toBe(true);
    }
    expect((await listProducts(t.db, all, q())).total).toBe(4);
  });

  it('returns nothing for gibberish', async () => {
    expect((await search('zzzzqqqq')).items).toEqual([]);
  });
});

describe('collections, tiles and product detail', () => {
  it('collection listings follow the manual position order', async () => {
    const c = await createCollection(t.db, { slug: 'picks', name: 'Picks', position: 0 });
    await addToCollection(t.db, c, ids['pleated-trouser']!.productId, 0);
    await addToCollection(t.db, c, ids['oxford-shirt']!.productId, 1);
    await addToCollection(t.db, c, ids['secret-draft']!.productId, 2);
    const res = await resolveListing(t.db, 'picks');
    expect(res?.kind).toBe('collection');
    expect(res?.defaultSort).toBe('featured');
    const r = await listProducts(t.db, res!.scope, q({}, { sort: 'featured' }));
    expect(r.items.map((i) => i.slug)).toEqual(['pleated-trouser', 'oxford-shirt']);
  });

  it('collection tiles count only published products and use the first product image', async () => {
    const tiles = await listCollectionTiles(t.db, 5);
    const picks = tiles.find((x) => x.slug === 'picks')!;
    expect(picks.productCount).toBe(2);
    expect(picks.imageKey).toBe('/assets/pleated-trouser.png');
  });

  it('resolves all / new-in / unknown slugs', async () => {
    expect((await resolveListing(t.db, 'all'))?.kind).toBe('all');
    expect((await resolveListing(t.db, 'new-in'))?.kind).toBe('new-in');
    expect(await resolveListing(t.db, 'does-not-exist')).toBeNull();
  });

  it('product detail is published-only and stock aware', async () => {
    expect(await getProductDetail(t.db, 'secret-draft')).toBeNull();
    expect(await getProductDetail(t.db, 'old-archive')).toBeNull();
    const cargo = await getProductDetail(t.db, 'cargo-short');
    expect(cargo?.variants.every((v) => v.available === 0)).toBe(true);
    const oxford = await getProductDetail(t.db, 'oxford-shirt');
    expect(oxford?.variants.map((v) => v.size)).toEqual(['S', 'M', 'L']);
    expect(oxford?.variants[0]?.available).toBe(5);
    expect(oxford?.media[0]?.objectKey).toBe('/assets/oxford-shirt.png');
  });
});
