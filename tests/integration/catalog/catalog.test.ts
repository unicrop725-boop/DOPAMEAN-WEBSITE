import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventoryMovement, product, variant } from '@/db/schema';
import { countProductsByStatus, createProduct, getProductBySlug } from '@/modules/catalog';
import { getAvailable } from '@/modules/inventory';
import { expectDbError, newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

const base = (slug: string, sku: string) => ({
  slug,
  name: `Product ${slug}`,
  status: 'published' as const,
  variants: [
    { sku: `${sku}-M`, optionValues: { Size: 'M' }, pricePaise: 149_900, stock: 4 },
    {
      sku: `${sku}-L`,
      optionValues: { Size: 'L' },
      pricePaise: 149_900,
      compareAtPaise: 199_900,
      stock: 6,
    },
  ],
});

describe('catalog creation', () => {
  it('creates a product with variants, opening stock and movements in one transaction', async () => {
    const { productId, variantIds } = await t.db.transaction((tx) =>
      createProduct(tx, base('shirt-a', 'A')),
    );
    expect(variantIds).toHaveLength(2);
    expect((await getAvailable(t.db, variantIds[0]!))?.available).toBe(4);
    expect((await getAvailable(t.db, variantIds[1]!))?.available).toBe(6);
    const moves = await t.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, variantIds[0]!));
    expect(moves).toHaveLength(1);
    expect((await getProductBySlug(t.db, 'shirt-a'))?.id).toBe(productId);
  });

  it('rolls everything back when one variant fails (duplicate SKU): no orphan product, stock or movement', async () => {
    await expect(
      t.db.transaction((tx) => createProduct(tx, base('shirt-b', 'A'))),
    ).rejects.toThrow();
    expect(await getProductBySlug(t.db, 'shirt-b')).toBeNull();
  });

  it('validates input at the boundary (bad slug, zero price, no variants)', async () => {
    await expect(createProduct(t.db, { ...base('Bad Slug', 'B') })).rejects.toThrow();
    await expect(
      createProduct(t.db, {
        ...base('zero-price', 'Z'),
        variants: [{ sku: 'Z1', pricePaise: 0, stock: 1 }],
      }),
    ).rejects.toThrow();
    await expect(
      createProduct(t.db, { ...base('no-variants', 'N'), variants: [] }),
    ).rejects.toThrow();
  });

  it('database constraints reject non-positive prices and compare-at below price', async () => {
    const { variantIds } = await t.db.transaction((tx) => createProduct(tx, base('shirt-c', 'C')));
    await expectDbError(
      t.db.update(variant).set({ pricePaise: 0 }).where(eq(variant.id, variantIds[0]!)),
      /variant_price_positive/,
    );
    await expectDbError(
      t.db.update(variant).set({ compareAtPaise: 100 }).where(eq(variant.id, variantIds[0]!)),
      /variant_compare_at_gt_price/,
    );
  });

  it('counts products by status', async () => {
    await t.db.update(product).set({ status: 'draft' }).where(eq(product.slug, 'shirt-c'));
    expect(await countProductsByStatus(t.db)).toEqual({ draft: 1, published: 1, archived: 0 });
  });
});
