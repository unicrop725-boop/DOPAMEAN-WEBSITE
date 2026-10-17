import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditEvent,
  category,
  collection,
  collectionProduct,
  inventoryLevel,
  order,
  payment,
  product,
  productMedia,
  variant,
} from '@/db/schema';
import {
  cancelOrderAdmin,
  collectCodAdmin,
  deliverOrderAdmin,
  shipOrderAdmin,
} from '@/lib/admin/orders';
import {
  createCategoryAdmin,
  createCollectionAdmin,
  createProductAdmin,
  deleteCategoryAdmin,
  deleteCollectionAdmin,
  removeProductMedia,
  reorderProductMedia,
  setProductCollections,
  setProductStatus,
  setVariantActive,
  updateCategoryAdmin,
  updateCollectionAdmin,
  updateMediaAlt,
  updateVariant,
  uploadProductMedia,
} from '@/modules/catalog';
import { placeOrder, type CheckoutDeps } from '@/modules/checkout';
import { setLowStockThresholdAdmin } from '@/modules/inventory';
import { newTestDb, type TestDb } from '../../support/test-db';
import { anon, checkoutInput, fillCart, makeDeps, seedShop, type Shop } from '../../support/shop';
import { actorOf, breakAuditFor, memoryStorage, owner, pngBytes } from '../../support/admin';

/**
 * Every remaining admin mutation, table-driven: (1) it writes exactly one audit event naming the actor, role,
 * IP and user agent, with before/after where there is something to compare; (2) when the audit write fails the
 * whole change rolls back (the audit row and the change commit or fail together, INV-14).
 */
let t: TestDb;
let shop: Shop;
let deps: CheckoutDeps;
const storage = memoryStorage();

beforeAll(async () => {
  t = await newTestDb(30);
  shop = await seedShop(t.db);
  deps = makeDeps(t.db);
});
afterAll(async () => {
  await t.close();
});

const actor = actorOf('manager', { ip: '198.51.100.23', userAgent: 'atomicity-test' });

async function fresh(slug: string) {
  const r = await createProductAdmin(t.db, owner(), {
    name: `P ${slug}`,
    slug,
    variants: [
      { sku: `${slug}-A`, pricePaise: 10_000, stock: 5 },
      { sku: `${slug}-B`, pricePaise: 12_000, stock: 5 },
    ],
  });
  return r;
}

async function snapshot(): Promise<string> {
  const rows = {
    product: await t.db.select().from(product),
    variant: await t.db.select().from(variant),
    media: await t.db.select().from(productMedia),
    category: await t.db.select().from(category),
    collection: await t.db.select().from(collection),
    membership: await t.db.select().from(collectionProduct),
    level: await t.db.select().from(inventoryLevel),
    order: await t.db.select().from(order),
    payment: await t.db.select().from(payment),
  };
  const key = (r: object) => JSON.stringify(Object.entries(r).sort());
  return JSON.stringify(
    Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.map(key).sort()])),
  );
}

async function audited(action: string, entityId: string) {
  const rows = await t.db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.action, action), eq(auditEvent.entityId, entityId)));
  return rows;
}

type Case = {
  action: string;
  /** Build fixtures for one run and return the thunk plus the audited entity id. */
  prepare: () => Promise<{ run: () => Promise<unknown>; entityId: string; compares?: boolean }>;
};

const ship = { carrier: 'DTDC', trackingNo: 'DT1234567' };
async function codOrder(variantId: string) {
  const o = anon();
  await fillCart(t.db, o, [[variantId, 1]]);
  return (await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'cod' }))).order;
}

let n = 0;
const cases: Case[] = [
  {
    action: 'product.publish',
    prepare: async () => {
      const p = await fresh(`pub-${n++}`);
      return {
        run: () => setProductStatus(t.db, actor, p.productId, 'published'),
        entityId: p.productId,
        compares: true,
      };
    },
  },
  {
    action: 'variant.update',
    prepare: async () => {
      const p = await fresh(`vu-${n++}`);
      const [v] = await t.db.select().from(variant).where(eq(variant.id, p.variantIds[0]!));
      return {
        run: () => updateVariant(t.db, actor, v!.id, { sku: v!.sku, pricePaise: 11_111 }),
        entityId: v!.id,
        compares: true,
      };
    },
  },
  {
    action: 'variant.deactivate',
    prepare: async () => {
      const p = await fresh(`vd-${n++}`);
      return {
        run: () => setVariantActive(t.db, actor, p.variantIds[0]!, false),
        entityId: p.variantIds[0]!,
        compares: true,
      };
    },
  },
  {
    action: 'product.media_update',
    prepare: async () => {
      const p = await fresh(`mu-${n++}`);
      const m = await uploadProductMedia(t.db, owner(), storage.storage, {
        productId: p.productId,
        bytes: await pngBytes(),
      });
      return {
        run: () => updateMediaAlt(t.db, actor, m.mediaId, 'New alt text'),
        entityId: p.productId,
        compares: true,
      };
    },
  },
  {
    action: 'product.media_reorder',
    prepare: async () => {
      const p = await fresh(`mr-${n++}`);
      const a = await uploadProductMedia(t.db, owner(), storage.storage, {
        productId: p.productId,
        bytes: await pngBytes(10, 10),
      });
      const b = await uploadProductMedia(t.db, owner(), storage.storage, {
        productId: p.productId,
        bytes: await pngBytes(11, 10),
      });
      return {
        run: () => reorderProductMedia(t.db, actor, p.productId, [b.mediaId, a.mediaId]),
        entityId: p.productId,
        compares: true,
      };
    },
  },
  {
    action: 'product.media_remove',
    prepare: async () => {
      const p = await fresh(`mx-${n++}`);
      const m = await uploadProductMedia(t.db, owner(), storage.storage, {
        productId: p.productId,
        bytes: await pngBytes(),
      });
      return {
        run: () => removeProductMedia(t.db, actor, storage.storage, m.mediaId),
        entityId: p.productId,
      };
    },
  },
  {
    action: 'product.collections',
    prepare: async () => {
      const p = await fresh(`pc-${n++}`);
      const c = await createCollectionAdmin(t.db, owner(), { name: `C ${n}`, slug: `c-${n}` });
      return {
        run: () => setProductCollections(t.db, actor, p.productId, [c.collectionId]),
        entityId: p.productId,
        compares: true,
      };
    },
  },
  {
    action: 'category.update',
    prepare: async () => {
      const c = await createCategoryAdmin(t.db, owner(), { name: `Cat ${n}`, slug: `cat-${n++}` });
      return {
        run: () =>
          updateCategoryAdmin(t.db, actor, c.categoryId, { name: 'Renamed', slug: `renamed-${n}` }),
        entityId: c.categoryId,
        compares: true,
      };
    },
  },
  {
    action: 'category.delete',
    prepare: async () => {
      const c = await createCategoryAdmin(t.db, owner(), { name: `Del ${n}`, slug: `del-${n++}` });
      return {
        run: () => deleteCategoryAdmin(t.db, actor, c.categoryId),
        entityId: c.categoryId,
        compares: true,
      };
    },
  },
  {
    action: 'collection.create',
    prepare: async () => {
      const slug = `col-new-${n++}`;
      return {
        run: () => createCollectionAdmin(t.db, actor, { name: 'New collection', slug }),
        entityId: '', // not known up front: looked up by action below
      };
    },
  },
  {
    action: 'collection.update',
    prepare: async () => {
      const c = await createCollectionAdmin(t.db, owner(), {
        name: `Col ${n}`,
        slug: `col-${n++}`,
      });
      return {
        run: () =>
          updateCollectionAdmin(t.db, actor, c.collectionId, {
            name: 'Edited',
            slug: `edited-${n}`,
            published: false,
          }),
        entityId: c.collectionId,
        compares: true,
      };
    },
  },
  {
    action: 'collection.delete',
    prepare: async () => {
      const c = await createCollectionAdmin(t.db, owner(), {
        name: `Gone ${n}`,
        slug: `gone-${n++}`,
      });
      return {
        run: () => deleteCollectionAdmin(t.db, actor, c.collectionId),
        entityId: c.collectionId,
        compares: true,
      };
    },
  },
  {
    action: 'inventory.set_threshold',
    prepare: async () => {
      const p = await fresh(`th-${n++}`);
      return {
        run: () =>
          setLowStockThresholdAdmin(t.db, actor, { variantId: p.variantIds[0]!, threshold: 9 }),
        entityId: p.variantIds[0]!,
        compares: true,
      };
    },
  },
  {
    action: 'order.deliver',
    prepare: async () => {
      const o = await codOrder(shop.shirt.variantIds[0]!);
      await shipOrderAdmin(deps, owner(), o.id, ship);
      return { run: () => deliverOrderAdmin(deps, actor, o.id), entityId: o.id, compares: true };
    },
  },
  {
    action: 'payment.cod_collected',
    prepare: async () => {
      const o = await codOrder(shop.shirt.variantIds[1]!);
      return { run: () => collectCodAdmin(deps, actor, o.id), entityId: o.id, compares: true };
    },
  },
  {
    action: 'order.cancel',
    prepare: async () => {
      const o = await codOrder(shop.shirt.variantIds[2]!);
      return {
        run: () => cancelOrderAdmin(deps, actor, o.id, { reason: 'atomicity test' }),
        entityId: o.id,
        compares: true,
      };
    },
  },
];

describe.each(cases.map((c) => [c.action, c] as const))('%s', (_action, c) => {
  it('writes one audit event with actor, role, ip, user agent and (where meaningful) before and after', async () => {
    const { run, entityId, compares } = await c.prepare();
    const all = await t.db.select().from(auditEvent).where(eq(auditEvent.action, c.action));
    const beforeCount = all.length;
    await run();
    const rows = await t.db.select().from(auditEvent).where(eq(auditEvent.action, c.action));
    expect(rows.length).toBe(beforeCount + 1);
    const row = entityId ? (await audited(c.action, entityId)).at(-1)! : rows.at(-1)!;
    expect(row).toMatchObject({
      actorUserId: actor.userId,
      actorRole: 'manager',
      ip: '198.51.100.23',
      userAgent: 'atomicity-test',
    });
    expect(row.after !== null || row.before !== null).toBe(true);
    if (compares) expect(row.before !== null).toBe(true);
  });

  it('rolls everything back when the audit write fails', async () => {
    const { run } = await c.prepare();
    const before = await snapshot();
    const restore = await breakAuditFor(t, c.action);
    try {
      await expect(run()).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(await snapshot()).toEqual(before);
  });
});
