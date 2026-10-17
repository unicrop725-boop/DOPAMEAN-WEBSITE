import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditEvent,
  category,
  collection,
  collectionProduct,
  inventoryLevel,
  inventoryMovement,
  product,
  productMedia,
  variant,
} from '@/db/schema';
import {
  addVariant,
  createCategoryAdmin,
  createCollectionAdmin,
  createProductAdmin,
  deleteCategoryAdmin,
  deleteCollectionAdmin,
  deleteProduct,
  getProductAdmin,
  listCategoriesAdmin,
  listCollectionsAdmin,
  listProductsAdmin,
  removeProductMedia,
  reorderProductMedia,
  setProductCollections,
  setProductStatus,
  setVariantActive,
  updateCategoryAdmin,
  updateCollectionAdmin,
  updateMediaAlt,
  updateProduct,
  updateVariant,
  uploadProductMedia,
} from '@/modules/catalog';
import { checkoutInput, fillCart, makeDeps, seedShop, anon, type Shop } from '../../support/shop';
import { placeOrder } from '@/modules/checkout';
import { newTestDb, type TestDb } from '../../support/test-db';
import {
  actorOf,
  auditCount,
  breakAuditFor,
  jpegBytes,
  manager,
  manager2faOff,
  memoryStorage,
  owner,
  owner2faOff,
  pngBytes,
  support,
} from '../../support/admin';

let t: TestDb;
let shop: Shop;
beforeAll(async () => {
  t = await newTestDb();
  shop = await seedShop(t.db);
});
afterAll(async () => {
  await t.close();
});

const newProduct = (slug: string, over: Record<string, unknown> = {}) => ({
  name: `Product ${slug}`,
  slug,
  variants: [{ sku: `${slug}-M`, optionValues: { Size: 'M' }, pricePaise: 99_900, stock: 5 }],
  ...over,
});

async function make(slug: string, actor = owner()) {
  return createProductAdmin(t.db, actor, newProduct(slug));
}
const audits = (entityId: string) =>
  t.db.select().from(auditEvent).where(eq(auditEvent.entityId, entityId));

describe('createProductAdmin', () => {
  it('creates a draft product, variants, opening stock and one audit event with ip and actor', async () => {
    const actor = manager();
    const { productId, variantIds } = await createProductAdmin(
      t.db,
      actor,
      newProduct('create-ok', {
        description: 'Soft cotton',
        hsnCode: '6109',
        taxRuleId: shop.taxRuleId,
        variants: [
          { sku: 'CO-M', optionValues: { Size: 'M' }, pricePaise: 99_900, stock: 7 },
          {
            sku: 'CO-L',
            optionValues: { Size: 'L' },
            pricePaise: 99_900,
            compareAtPaise: 129_900,
            stock: 3,
          },
        ],
      }),
    );
    const [p] = await t.db.select().from(product).where(eq(product.id, productId));
    expect(p).toMatchObject({
      status: 'draft',
      slug: 'create-ok',
      hsnCode: '6109',
      description: 'Soft cotton',
    });
    expect(variantIds).toHaveLength(2);
    const levels = await t.db
      .select()
      .from(inventoryLevel)
      .where(eq(inventoryLevel.variantId, variantIds[0]!));
    expect(levels[0]?.onHand).toBe(7);
    const moves = await t.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, variantIds[0]!));
    expect(moves[0]).toMatchObject({ reason: 'initial', actorUserId: actor.userId });
    const a = await audits(productId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      action: 'product.create',
      actorUserId: actor.userId,
      actorRole: 'manager',
      ip: '203.0.113.9',
      userAgent: 'vitest-admin',
      before: null,
    });
    expect((a[0]!.after as { slug: string }).slug).toBe('create-ok');
  });

  it('derives the slug from the name when blank', async () => {
    const { productId } = await createProductAdmin(t.db, owner(), {
      name: 'Heavy Weight Hoodie!',
      slug: '',
      variants: [{ sku: 'HWH-1', pricePaise: 5000, stock: 1 }],
    });
    const [p] = await t.db.select().from(product).where(eq(product.id, productId));
    expect(p?.slug).toBe('heavy-weight-hoodie');
  });

  it.each([
    ['price of zero', { variants: [{ sku: 'V1', pricePaise: 0, stock: 1 }] }, 'pricePaise'],
    ['negative stock', { variants: [{ sku: 'V2', pricePaise: 100, stock: -1 }] }, 'stock'],
    [
      'compare-at equal to price',
      { variants: [{ sku: 'V3', pricePaise: 100, compareAtPaise: 100, stock: 1 }] },
      'compareAtPaise',
    ],
    [
      'compare-at below price',
      { variants: [{ sku: 'V4', pricePaise: 100, compareAtPaise: 50, stock: 1 }] },
      'compareAtPaise',
    ],
    ['no variants', { variants: [] }, 'variants'],
    ['bad slug', { slug: 'Not A Slug' }, 'slug'],
    ['empty name', { name: '  ' }, 'name'],
    ['fractional price', { variants: [{ sku: 'V5', pricePaise: 10.5, stock: 1 }] }, 'pricePaise'],
  ])('rejects %s with a field error and writes nothing', async (_label, over, field) => {
    const before = await auditCount(t.db);
    const err = await createProductAdmin(t.db, owner(), newProduct('invalid-x', over)).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(Object.keys(err.details.fieldErrors)).toContain(field);
    expect(await auditCount(t.db)).toBe(before);
    expect(await t.db.select().from(product).where(eq(product.slug, 'invalid-x'))).toHaveLength(0);
  });

  it('enforces slug uniqueness and SKU uniqueness (in the database and within one request)', async () => {
    await make('uniq-a');
    await expect(make('uniq-a')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fieldErrors: { slug: expect.any(String) } },
    });
    await expect(
      createProductAdmin(t.db, owner(), {
        ...newProduct('uniq-b'),
        variants: [{ sku: 'uniq-a-M', pricePaise: 100, stock: 1 }],
      }),
    ).rejects.toMatchObject({ details: { fieldErrors: { sku: expect.any(String) } } });
    await expect(
      createProductAdmin(t.db, owner(), {
        ...newProduct('uniq-c'),
        variants: [
          { sku: 'DUP', pricePaise: 100, stock: 1 },
          { sku: 'DUP', pricePaise: 100, stock: 1 },
        ],
      }),
    ).rejects.toMatchObject({ details: { fieldErrors: { sku: expect.any(String) } } });
    expect(await t.db.select().from(product).where(eq(product.slug, 'uniq-b'))).toHaveLength(0);
    expect(await t.db.select().from(product).where(eq(product.slug, 'uniq-c'))).toHaveLength(0);
  });

  it('rejects a category or tax rule that does not exist', async () => {
    const ghost = '11111111-1111-4111-8111-111111111111';
    await expect(
      createProductAdmin(t.db, owner(), newProduct('ghost-cat', { categoryId: ghost })),
    ).rejects.toMatchObject({ details: { fieldErrors: { categoryId: expect.any(String) } } });
    await expect(
      createProductAdmin(t.db, owner(), newProduct('ghost-tax', { taxRuleId: ghost })),
    ).rejects.toMatchObject({ details: { fieldErrors: { taxRuleId: expect.any(String) } } });
  });

  it('rolls back the product, variants, stock and movements if the audit write fails', async () => {
    const restore = await breakAuditFor(t, 'product.create');
    try {
      await expect(make('rolled-back')).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(await t.db.select().from(product).where(eq(product.slug, 'rolled-back'))).toHaveLength(
      0,
    );
    expect(await t.db.select().from(variant).where(eq(variant.sku, 'rolled-back-M'))).toHaveLength(
      0,
    );
  });
});

describe('updateProduct', () => {
  it('updates fields, clears blanks to null, and audits before and after', async () => {
    const { productId } = await make('upd-1');
    const actor = manager();
    await updateProduct(t.db, actor, productId, {
      name: 'Renamed',
      slug: 'upd-1-renamed',
      description: 'New text',
      categoryId: null,
      hsnCode: '6205',
      taxRuleId: shop.taxRuleId,
      materials: '100% cotton',
      careGuide: '',
      shippingReturns: '',
      modelInfo: '',
      seoTitle: 'SEO',
      seoDescription: '',
    });
    const [p] = await t.db.select().from(product).where(eq(product.id, productId));
    expect(p).toMatchObject({
      name: 'Renamed',
      slug: 'upd-1-renamed',
      description: 'New text',
      hsnCode: '6205',
      careGuide: null,
      seoTitle: 'SEO',
      seoDescription: null,
    });
    const a = (await audits(productId)).find((r) => r.action === 'product.update')!;
    expect(a).toMatchObject({ actorUserId: actor.userId, ip: '203.0.113.9' });
    expect(a.before).toMatchObject({ name: 'Product upd-1', slug: 'upd-1' });
    expect(a.after).toMatchObject({ name: 'Renamed', slug: 'upd-1-renamed' });
  });

  it('refuses a slug used by another product but allows keeping its own', async () => {
    const a = await make('slug-a');
    await make('slug-b');
    const base = { name: 'X', description: null, categoryId: null, hsnCode: null, taxRuleId: null };
    await expect(
      updateProduct(t.db, owner(), a.productId, { ...base, slug: 'slug-b' }),
    ).rejects.toMatchObject({ details: { fieldErrors: { slug: expect.any(String) } } });
    await updateProduct(t.db, owner(), a.productId, { ...base, slug: 'slug-a' });
  });

  it('unknown product is NOT_FOUND; invalid input is VALIDATION_FAILED', async () => {
    await expect(
      updateProduct(t.db, owner(), '11111111-1111-4111-8111-111111111111', {
        name: 'x',
        slug: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { productId } = await make('upd-bad');
    await expect(
      updateProduct(t.db, owner(), productId, { name: '', slug: 'ok' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rolls back when the audit write fails', async () => {
    const { productId } = await make('upd-rb');
    const restore = await breakAuditFor(t, 'product.update');
    try {
      await expect(
        updateProduct(t.db, owner(), productId, { name: 'Changed', slug: 'upd-rb' }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    const [p] = await t.db.select().from(product).where(eq(product.id, productId));
    expect(p?.name).toBe('Product upd-rb');
  });
});

describe('setProductStatus', () => {
  it('publishes, unpublishes and archives with distinct audit actions', async () => {
    const { productId } = await make('status-1');
    await setProductStatus(t.db, owner(), productId, 'published');
    await setProductStatus(t.db, owner(), productId, 'draft');
    await setProductStatus(t.db, owner(), productId, 'archived');
    const actions = (await audits(productId)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['product.publish', 'product.unpublish', 'product.archive']),
    );
    const [p] = await t.db.select().from(product).where(eq(product.id, productId));
    expect(p?.status).toBe('archived');
  });

  it('refuses to publish without an active variant, and repeating the same status', async () => {
    const { productId, variantIds } = await make('status-2');
    await setVariantActive(t.db, owner(), variantIds[0]!, false);
    await expect(setProductStatus(t.db, owner(), productId, 'published')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(setProductStatus(t.db, owner(), productId, 'draft')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('variants', () => {
  it('adds a variant with stock, then updates and deactivates it', async () => {
    const { productId } = await make('var-1');
    const { variantId } = await addVariant(t.db, owner(), productId, {
      sku: 'var-1-L',
      optionValues: { Size: 'L' },
      pricePaise: 109_900,
      compareAtPaise: 149_900,
      stock: 4,
    });
    const lvl = await t.db
      .select()
      .from(inventoryLevel)
      .where(eq(inventoryLevel.variantId, variantId));
    expect(lvl[0]?.onHand).toBe(4);

    await updateVariant(t.db, manager(), variantId, {
      sku: 'var-1-L2',
      optionValues: { Size: 'L' },
      pricePaise: 119_900,
      compareAtPaise: null,
    });
    const [v] = await t.db.select().from(variant).where(eq(variant.id, variantId));
    expect(v).toMatchObject({ sku: 'var-1-L2', pricePaise: 119_900, compareAtPaise: null });
    const upd = (await audits(variantId)).find((a) => a.action === 'variant.update')!;
    expect(upd.before).toMatchObject({
      sku: 'var-1-L',
      pricePaise: 109_900,
      compareAtPaise: 149_900,
    });
    expect(upd.after).toMatchObject({ sku: 'var-1-L2', pricePaise: 119_900 });

    await setVariantActive(t.db, owner(), variantId, false);
    const [off] = await t.db.select().from(variant).where(eq(variant.id, variantId));
    expect(off?.active).toBe(false);
    await expect(setVariantActive(t.db, owner(), variantId, false)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await setVariantActive(t.db, owner(), variantId, true);
  });

  it('SKU must be unique across all products; price and compare-at rules match the database checks', async () => {
    const a = await make('var-2');
    const b = await make('var-3');
    const second = await addVariant(t.db, owner(), a.productId, {
      sku: 'var-2-X',
      pricePaise: 5000,
      stock: 1,
    });
    await expect(
      addVariant(t.db, owner(), b.productId, { sku: 'var-2-X', pricePaise: 5000, stock: 1 }),
    ).rejects.toMatchObject({ details: { fieldErrors: { sku: expect.any(String) } } });
    await expect(
      updateVariant(t.db, owner(), second.variantId, {
        sku: 'var-3-M',
        pricePaise: 5000,
      }),
    ).rejects.toMatchObject({ details: { fieldErrors: { sku: expect.any(String) } } });
    for (const [price, compare] of [
      [0, undefined],
      [5000, 5000],
      [5000, 4000],
    ] as const) {
      await expect(
        updateVariant(t.db, owner(), second.variantId, {
          sku: 'var-2-X',
          pricePaise: price,
          compareAtPaise: compare,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    // nothing changed
    const [v] = await t.db.select().from(variant).where(eq(variant.id, second.variantId));
    expect(v).toMatchObject({ sku: 'var-2-X', pricePaise: 5000 });
  });

  it('the last active variant of a published product cannot be deactivated', async () => {
    const { productId, variantIds } = await make('var-4');
    await setProductStatus(t.db, owner(), productId, 'published');
    await expect(setVariantActive(t.db, owner(), variantIds[0]!, false)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await setProductStatus(t.db, owner(), productId, 'draft');
    await setVariantActive(t.db, owner(), variantIds[0]!, false);
  });

  it('rolls back the new variant and its stock if the audit write fails', async () => {
    const { productId } = await make('var-5');
    const restore = await breakAuditFor(t, 'variant.create');
    try {
      await expect(
        addVariant(t.db, owner(), productId, { sku: 'var-5-Z', pricePaise: 100, stock: 9 }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(await t.db.select().from(variant).where(eq(variant.sku, 'var-5-Z'))).toHaveLength(0);
  });
});

describe('deleteProduct', () => {
  it('hard-deletes a product that was never ordered, including variants, stock and media rows', async () => {
    const { productId, variantIds } = await make('del-1');
    const { storage } = memoryStorage();
    await uploadProductMedia(t.db, owner(), storage, { productId, bytes: await pngBytes() });
    const out = await deleteProduct(t.db, owner(), productId);
    expect(out.mode).toBe('deleted');
    expect(await t.db.select().from(product).where(eq(product.id, productId))).toHaveLength(0);
    expect(await t.db.select().from(variant).where(eq(variant.productId, productId))).toHaveLength(
      0,
    );
    expect(
      await t.db.select().from(inventoryLevel).where(eq(inventoryLevel.variantId, variantIds[0]!)),
    ).toHaveLength(0);
    expect(
      await t.db.select().from(productMedia).where(eq(productMedia.productId, productId)),
    ).toHaveLength(0);
    const a = (await audits(productId)).find((r) => r.action === 'product.delete')!;
    expect(a.after).toMatchObject({ mode: 'deleted' });
  });

  it('a product that was ordered is archived and hidden, never hard-deleted, and the order keeps its lines', async () => {
    const deps = makeDeps(t.db);
    const o = anon();
    await fillCart(t.db, o, [[shop.tee.variantIds[0]!, 1]]);
    const placed = await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'cod' }));
    const out = await deleteProduct(t.db, owner(), shop.tee.productId);
    expect(out.mode).toBe('archived');
    const [p] = await t.db.select().from(product).where(eq(product.id, shop.tee.productId));
    expect(p).toMatchObject({ status: 'archived' });
    expect(p?.deletedAt).not.toBeNull();
    expect(await getProductAdmin(t.db, owner(), shop.tee.productId)).toBeNull();
    const { getOrderDetail } = await import('@/modules/orders');
    const detail = await getOrderDetail(t.db, placed.order.id);
    expect(detail?.lines[0]).toMatchObject({ productName: 'Boxy Tee', sku: 'boxy-tee-M' });
    // and it can no longer be edited or deleted again
    await expect(deleteProduct(t.db, owner(), shop.tee.productId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rolls back a hard delete when the audit write fails', async () => {
    const { productId, variantIds } = await make('del-rb');
    const restore = await breakAuditFor(t, 'product.delete');
    try {
      await expect(deleteProduct(t.db, owner(), productId)).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(await t.db.select().from(product).where(eq(product.id, productId))).toHaveLength(1);
    expect(
      await t.db.select().from(inventoryLevel).where(eq(inventoryLevel.variantId, variantIds[0]!)),
    ).toHaveLength(1);
  });
});

describe('media upload, alt text, reorder, remove', () => {
  it('re-encodes to WebP, stores under a random key, records dimensions and audits', async () => {
    const { productId } = await make('media-1');
    const mem = memoryStorage();
    const actor = manager();
    const res = await uploadProductMedia(t.db, actor, mem.storage, {
      productId,
      bytes: await pngBytes(3000, 1000),
      alt: 'Front view',
    });
    expect(res.objectKey).toMatch(/^products\/[0-9a-f]{32}\.webp$/);
    expect(res.width).toBe(2400); // capped to 2400 px on the long edge
    expect(res.height).toBe(800);
    const stored = mem.objects.get(res.objectKey)!;
    expect(stored.contentType).toBe('image/webp');
    expect(stored.body.subarray(0, 4).toString('latin1')).toBe('RIFF');
    const [row] = await t.db.select().from(productMedia).where(eq(productMedia.id, res.mediaId));
    expect(row).toMatchObject({ alt: 'Front view', width: 2400, height: 800, position: 0 });
    const a = (await audits(productId)).find((r) => r.action === 'product.media_add')!;
    expect(a).toMatchObject({ actorUserId: actor.userId, ip: '203.0.113.9' });
  });

  it('defaults the alt text to the product name and refuses empty alt on update', async () => {
    const { productId } = await make('media-2');
    const { storage } = memoryStorage();
    const m = await uploadProductMedia(t.db, owner(), storage, {
      productId,
      bytes: await jpegBytes(),
    });
    const [row] = await t.db.select().from(productMedia).where(eq(productMedia.id, m.mediaId));
    expect(row?.alt).toBe('Product media-2');
    await updateMediaAlt(t.db, owner(), m.mediaId, 'A green swatch');
    await expect(updateMediaAlt(t.db, owner(), m.mediaId, '  ')).rejects.toThrow();
    const [after] = await t.db.select().from(productMedia).where(eq(productMedia.id, m.mediaId));
    expect(after?.alt).toBe('A green swatch');
  });

  it('refuses SVG, wrong bytes, oversize and polyglot uploads and stores nothing', async () => {
    const { productId } = await make('media-3');
    const mem = memoryStorage();
    const before = await auditCount(t.db);
    const bad: [string, Uint8Array][] = [
      [
        'svg',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      ],
      ['text', Buffer.from('hello world')],
      ['exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])],
      ['oversize', Buffer.concat([await pngBytes(), Buffer.alloc(5 * 1024 * 1024 + 1)])],
      ['polyglot', Buffer.concat([await pngBytes(), Buffer.from('<script>alert(1)</script>')])],
      ['empty', new Uint8Array()],
    ];
    for (const [label, bytes] of bad) {
      await expect(
        uploadProductMedia(t.db, owner(), mem.storage, { productId, bytes }),
        label,
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(mem.objects.size).toBe(0);
    expect(await auditCount(t.db)).toBe(before);
  });

  it('removes the stored object when the database step fails', async () => {
    const { productId } = await make('media-4');
    const mem = memoryStorage();
    const restore = await breakAuditFor(t, 'product.media_add');
    try {
      await expect(
        uploadProductMedia(t.db, owner(), mem.storage, { productId, bytes: await pngBytes() }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(mem.objects.size).toBe(0);
    expect(
      await t.db.select().from(productMedia).where(eq(productMedia.productId, productId)),
    ).toHaveLength(0);
  });

  it('a storage outage fails the upload without touching the database', async () => {
    const { productId } = await make('media-5');
    const mem = memoryStorage();
    mem.setFailPut(true);
    await expect(
      uploadProductMedia(t.db, owner(), mem.storage, { productId, bytes: await pngBytes() }),
    ).rejects.toThrow('storage unavailable');
    expect(
      await t.db.select().from(productMedia).where(eq(productMedia.productId, productId)),
    ).toHaveLength(0);
  });

  it('reorders, validates the id set, removes (closing the gap) and deletes the stored object', async () => {
    const { productId } = await make('media-6');
    const mem = memoryStorage();
    const ids: string[] = [];
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await uploadProductMedia(t.db, owner(), mem.storage, {
        productId,
        bytes: await pngBytes(10 + i, 10),
        alt: `img ${i}`,
      });
      ids.push(m.mediaId);
      keys.push(m.objectKey);
    }
    await reorderProductMedia(t.db, owner(), productId, [ids[2]!, ids[0]!, ids[1]!]);
    let rows = await t.db.select().from(productMedia).where(eq(productMedia.productId, productId));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.position]))).toEqual({
      [ids[2]!]: 0,
      [ids[0]!]: 1,
      [ids[1]!]: 2,
    });
    await expect(
      reorderProductMedia(t.db, owner(), productId, [ids[0]!, ids[1]!]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await removeProductMedia(t.db, owner(), mem.storage, ids[0]!);
    rows = await t.db.select().from(productMedia).where(eq(productMedia.productId, productId));
    expect(rows).toHaveLength(2);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.position]))).toEqual({
      [ids[2]!]: 0,
      [ids[1]!]: 1,
    });
    expect(mem.objects.has(keys[0]!)).toBe(false);
    expect(mem.objects.has(keys[1]!)).toBe(true);
    const a = (await audits(productId)).find((r) => r.action === 'product.media_remove')!;
    expect(a.before).toMatchObject({ mediaId: ids[0] });
  });

  it('never deletes seeded site-path images from storage', async () => {
    const { productId } = await make('media-7');
    await t.db.insert(productMedia).values({
      productId,
      objectKey: '/assets/sample.png',
      alt: 'sample',
      width: 10,
      height: 10,
    });
    const [row] = await t.db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, productId));
    const mem = memoryStorage();
    await mem.storage.put('/assets/sample.png', Buffer.from('x'), 'image/png');
    await removeProductMedia(t.db, owner(), mem.storage, row!.id);
    expect(mem.objects.has('/assets/sample.png')).toBe(true);
  });
});

describe('collections and categories', () => {
  it('replaces collection membership and audits before and after', async () => {
    const { productId } = await make('coll-1');
    const c1 = await createCollectionAdmin(t.db, owner(), { name: 'Summer', slug: '' });
    const c2 = await createCollectionAdmin(t.db, owner(), { name: 'Winter', slug: 'winter' });
    await setProductCollections(t.db, owner(), productId, [c1.collectionId, c2.collectionId]);
    let rows = await t.db
      .select()
      .from(collectionProduct)
      .where(eq(collectionProduct.productId, productId));
    expect(rows).toHaveLength(2);
    await setProductCollections(t.db, owner(), productId, [c2.collectionId]);
    rows = await t.db
      .select()
      .from(collectionProduct)
      .where(eq(collectionProduct.productId, productId));
    expect(rows.map((r) => r.collectionId)).toEqual([c2.collectionId]);
    const a = (await audits(productId)).filter((r) => r.action === 'product.collections');
    expect(a).toHaveLength(2);
    expect(a[1]!.before).toMatchObject({
      collectionIds: [c1.collectionId, c2.collectionId].sort(),
    });
    await expect(
      setProductCollections(t.db, owner(), productId, ['11111111-1111-4111-8111-111111111111']),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('collection CRUD: duplicate slug refused, update, delete removes membership only', async () => {
    const { productId } = await make('coll-2');
    const c = await createCollectionAdmin(t.db, owner(), { name: 'Drop 1', slug: 'drop-1' });
    await expect(
      createCollectionAdmin(t.db, owner(), { name: 'Other', slug: 'drop-1' }),
    ).rejects.toMatchObject({ details: { fieldErrors: { slug: expect.any(String) } } });
    await updateCollectionAdmin(t.db, owner(), c.collectionId, {
      name: 'Drop One',
      slug: 'drop-1',
      description: 'First drop',
      published: false,
    });
    const [row] = await t.db.select().from(collection).where(eq(collection.id, c.collectionId));
    expect(row).toMatchObject({ name: 'Drop One', published: false, description: 'First drop' });
    await setProductCollections(t.db, owner(), productId, [c.collectionId]);
    const res = await deleteCollectionAdmin(t.db, owner(), c.collectionId);
    expect(res.membersRemoved).toBe(1);
    expect((await t.db.select().from(product).where(eq(product.id, productId))).length).toBe(1);
    expect((await listCollectionsAdmin(t.db, owner())).some((x) => x.id === c.collectionId)).toBe(
      false,
    );
  });

  it('category CRUD: parent cycles refused, delete refused with children, products become uncategorised', async () => {
    const parent = await createCategoryAdmin(t.db, owner(), { name: 'Outer', slug: 'outer' });
    const child = await createCategoryAdmin(t.db, owner(), {
      name: 'Inner',
      slug: 'inner',
      parentId: parent.categoryId,
    });
    await expect(
      updateCategoryAdmin(t.db, owner(), parent.categoryId, {
        name: 'Outer',
        slug: 'outer',
        parentId: child.categoryId,
      }),
    ).rejects.toMatchObject({ details: { fieldErrors: { parentId: expect.any(String) } } });
    await expect(
      updateCategoryAdmin(t.db, owner(), parent.categoryId, {
        name: 'Outer',
        slug: 'outer',
        parentId: parent.categoryId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(deleteCategoryAdmin(t.db, owner(), parent.categoryId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      createCategoryAdmin(t.db, owner(), { name: 'Dup', slug: 'inner' }),
    ).rejects.toMatchObject({ details: { fieldErrors: { slug: expect.any(String) } } });

    const { productId } = await createProductAdmin(
      t.db,
      owner(),
      newProduct('cat-prod', { categoryId: child.categoryId }),
    );
    const res = await deleteCategoryAdmin(t.db, owner(), child.categoryId);
    expect(res.productsUncategorised).toBe(1);
    const [p] = await t.db.select().from(product).where(eq(product.id, productId));
    expect(p?.categoryId).toBeNull();
    expect(
      await t.db.select().from(category).where(eq(category.id, child.categoryId)),
    ).toHaveLength(0);
    const list = await listCategoriesAdmin(t.db, owner());
    expect(list.find((c) => c.id === parent.categoryId)?.productCount).toBe(0);
  });

  it('rolls back category creation when the audit write fails', async () => {
    const restore = await breakAuditFor(t, 'category.create');
    try {
      await expect(
        createCategoryAdmin(t.db, owner(), { name: 'Gone', slug: 'gone' }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(await t.db.select().from(category).where(eq(category.slug, 'gone'))).toHaveLength(0);
  });
});

describe('admin reads', () => {
  it('lists products with search (name, slug, SKU), status filter and bounded pagination', async () => {
    const all = await listProductsAdmin(t.db, owner(), { pageSize: 500 });
    expect(all.pageSize).toBe(100);
    expect(all.total).toBeGreaterThan(5);
    const bySku = await listProductsAdmin(t.db, owner(), { q: 'oxford-shirt-M' });
    expect(bySku.items.map((p) => p.slug)).toEqual(['oxford-shirt']);
    expect(bySku.items[0]).toMatchObject({
      variantCount: 3,
      minPricePaise: 149_900,
      maxPricePaise: 149_900,
      available: 180,
      status: 'published',
    });
    const drafts = await listProductsAdmin(t.db, owner(), { status: 'draft' });
    expect(drafts.items.every((p) => p.status === 'draft')).toBe(true);
    const paged = await listProductsAdmin(t.db, owner(), { pageSize: 2, page: 2 });
    expect(paged.items).toHaveLength(2);
    expect(paged.page).toBe(2);
    const like = await listProductsAdmin(t.db, owner(), { q: '%' }); // wildcard is escaped
    expect(like.total).toBe(0);
  });

  it('getProductAdmin returns variants with stock, media, collections and the ordered flag', async () => {
    const detail = await getProductAdmin(t.db, owner(), shop.shirt.productId);
    expect(detail?.variants).toHaveLength(3);
    expect(detail?.variants[0]).toMatchObject({ onHand: 60, reserved: 0, available: 60 });
    expect(detail?.media).toHaveLength(1);
    expect(await getProductAdmin(t.db, owner(), 'not-a-uuid')).toBeNull();
  });
});

describe('authorization on every catalog admin function', () => {
  const ghost = '11111111-1111-4111-8111-111111111111';
  type Call = (actor: ReturnType<typeof owner>) => Promise<unknown>;
  const cases: [string, Call][] = [
    ['createProductAdmin', (a) => createProductAdmin(t.db, a, newProduct('authz-1'))],
    [
      'updateProduct',
      (a) => updateProduct(t.db, a, shop.shirt.productId, { name: 'Hack', slug: 'oxford-shirt' }),
    ],
    ['setProductStatus', (a) => setProductStatus(t.db, a, shop.shirt.productId, 'archived')],
    ['deleteProduct', (a) => deleteProduct(t.db, a, shop.shirt.productId)],
    [
      'addVariant',
      (a) =>
        addVariant(t.db, a, shop.shirt.productId, { sku: 'authz-v', pricePaise: 100, stock: 1 }),
    ],
    [
      'updateVariant',
      (a) =>
        updateVariant(t.db, a, shop.shirt.variantIds[0]!, { sku: 'oxford-shirt-S', pricePaise: 1 }),
    ],
    ['setVariantActive', (a) => setVariantActive(t.db, a, shop.shirt.variantIds[0]!, false)],
    [
      'uploadProductMedia',
      async (a) =>
        uploadProductMedia(t.db, a, memoryStorage().storage, {
          productId: shop.shirt.productId,
          bytes: await pngBytes(),
        }),
    ],
    ['updateMediaAlt', (a) => updateMediaAlt(t.db, a, ghost, 'x')],
    ['removeProductMedia', (a) => removeProductMedia(t.db, a, null, ghost)],
    ['reorderProductMedia', (a) => reorderProductMedia(t.db, a, shop.shirt.productId, [ghost])],
    ['setProductCollections', (a) => setProductCollections(t.db, a, shop.shirt.productId, [])],
    ['createCategoryAdmin', (a) => createCategoryAdmin(t.db, a, { name: 'N', slug: 'n-cat' })],
    ['updateCategoryAdmin', (a) => updateCategoryAdmin(t.db, a, ghost, { name: 'N', slug: 'n' })],
    ['deleteCategoryAdmin', (a) => deleteCategoryAdmin(t.db, a, ghost)],
    ['createCollectionAdmin', (a) => createCollectionAdmin(t.db, a, { name: 'N', slug: 'n-col' })],
    [
      'updateCollectionAdmin',
      (a) => updateCollectionAdmin(t.db, a, ghost, { name: 'N', slug: 'n' }),
    ],
    ['deleteCollectionAdmin', (a) => deleteCollectionAdmin(t.db, a, ghost)],
    ['listProductsAdmin', (a) => listProductsAdmin(t.db, a)],
    ['getProductAdmin', (a) => getProductAdmin(t.db, a, shop.shirt.productId)],
    ['listCategoriesAdmin', (a) => listCategoriesAdmin(t.db, a)],
    ['listCollectionsAdmin', (a) => listCollectionsAdmin(t.db, a)],
  ];

  it.each(cases)('%s: support is FORBIDDEN and nothing is written', async (_name, call) => {
    const before = await auditCount(t.db);
    await expect(call(support())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await auditCount(t.db)).toBe(before);
  });

  it.each(cases)(
    '%s: manager and owner without 2FA get TWO_FACTOR_REQUIRED',
    async (_name, call) => {
      const before = await auditCount(t.db);
      await expect(call(manager2faOff())).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
      await expect(call(owner2faOff())).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
      expect(await auditCount(t.db)).toBe(before);
    },
  );

  it('the product from the denied calls is untouched', async () => {
    const [p] = await t.db.select().from(product).where(eq(product.id, shop.shirt.productId));
    expect(p).toMatchObject({ name: 'Oxford Shirt', status: 'published' });
    expect(await t.db.select().from(product).where(eq(product.slug, 'authz-1'))).toHaveLength(0);
    const active = await t.db
      .select()
      .from(variant)
      .where(and(eq(variant.productId, shop.shirt.productId), eq(variant.active, true)));
    expect(active).toHaveLength(3);
  });

  it('the actorOf helper really is a manager context (sanity)', () => {
    expect(actorOf('manager').role).toBe('manager');
  });
});
