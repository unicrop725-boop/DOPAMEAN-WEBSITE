import { and, asc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/modules/audit';
import {
  availableQtySql,
  initStock,
  lowStockThresholdSql,
  onHandQtySql,
  purgeStock,
  reservedQtySql,
} from '@/modules/inventory';
import { productEverOrdered } from '@/modules/orders';
import { assertCan, auditActorOf, type AdminActor } from '@/modules/staff';
import { loadTaxRules } from '@/modules/tax';
import {
  categoryInput,
  collectionInput,
  createProductInput,
  newVariantInput,
  PRODUCT_STATUSES,
  productFieldsInput,
  slugify,
  variantFieldsInput,
  type CategoryInput,
  type CollectionInput,
  type CreateProductAdminInput,
  type NewVariantInput,
  type ProductFieldsInput,
  type ProductStatus,
  type VariantFieldsInput,
} from './domain/admin-input';
import { isManagedMediaKey, processImageUpload, newMediaKey, type ObjectStorage } from './media';
import { category, collection, collectionProduct, product, productMedia, variant } from './schema';

export { slugify, PRODUCT_STATUSES };
export type { ProductStatus };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// ---- helpers --------------------------------------------------------------------------------------

function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  return { code: e?.cause?.code ?? e?.code, constraint: e?.cause?.constraint ?? e?.constraint };
}

/** Turn constraint violations that slipped past our own checks (races) into field-level validation errors. */
function translateDbError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  const { code, constraint } = pgError(err);
  if (code === '23505') {
    if (constraint?.includes('sku')) {
      return new AppError('VALIDATION_FAILED', 'That SKU is already used by another variant.', {
        fieldErrors: { sku: 'This SKU is already in use' },
      });
    }
    if (constraint?.includes('slug')) {
      return new AppError('VALIDATION_FAILED', 'That URL slug is already in use.', {
        fieldErrors: { slug: 'This slug is already in use' },
      });
    }
  }
  if (code === '23514') {
    return new AppError(
      'VALIDATION_FAILED',
      'Prices must be positive and compare-at must exceed price.',
    );
  }
  return err;
}

async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(fn);
  } catch (err) {
    throw translateDbError(err);
  }
}

function parseOrThrow<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const res = schema.safeParse(raw);
  if (res.success) return res.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of res.error.issues) {
    // Errors inside variants[i] are keyed by their field name (sku, pricePaise ...): the form has one variant row.
    const key =
      issue.path[0] === 'variants' && issue.path.length > 1
        ? String(issue.path.at(-1))
        : String(issue.path[0] ?? 'form');
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  throw new AppError('VALIDATION_FAILED', Object.values(fieldErrors)[0] ?? 'Invalid input', {
    fieldErrors,
  });
}

const fieldError = (field: string, message: string) =>
  new AppError('VALIDATION_FAILED', message, { fieldErrors: { [field]: message } });

type ProductRow = typeof product.$inferSelect;

async function lockProduct(tx: Tx, productId: string): Promise<ProductRow> {
  const [row] = await tx
    .select()
    .from(product)
    .where(and(eq(product.id, productId), isNull(product.deletedAt)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', 'Product not found.');
  return row;
}

async function assertReferences(
  tx: DbOrTx,
  f: { categoryId: string | null; taxRuleId: string | null },
): Promise<void> {
  if (f.categoryId) {
    const [c] = await tx
      .select({ id: category.id })
      .from(category)
      .where(eq(category.id, f.categoryId));
    if (!c) throw fieldError('categoryId', 'That category no longer exists');
  }
  if (f.taxRuleId) {
    const rules = await loadTaxRules(tx, [f.taxRuleId]);
    if (!rules.has(f.taxRuleId)) throw fieldError('taxRuleId', 'That tax rule no longer exists');
  }
}

async function assertSlugFree(tx: DbOrTx, slug: string, exceptProductId?: string): Promise<void> {
  const [row] = await tx
    .select({ id: product.id })
    .from(product)
    .where(
      exceptProductId
        ? and(eq(product.slug, slug), ne(product.id, exceptProductId))
        : eq(product.slug, slug),
    );
  if (row) throw fieldError('slug', 'This slug is already in use');
}

async function assertSkuFree(tx: DbOrTx, sku: string, exceptVariantId?: string): Promise<void> {
  const [row] = await tx
    .select({ id: variant.id })
    .from(variant)
    .where(
      exceptVariantId
        ? and(eq(variant.sku, sku), ne(variant.id, exceptVariantId))
        : eq(variant.sku, sku),
    );
  if (row) throw fieldError('sku', 'This SKU is already in use');
}

const productSnapshot = (p: ProductRow) => ({
  name: p.name,
  slug: p.slug,
  status: p.status,
  description: p.description,
  categoryId: p.categoryId,
  hsnCode: p.hsnCode,
  taxRuleId: p.taxRuleId,
  materials: p.materials,
  careGuide: p.careGuide,
  shippingReturns: p.shippingReturns,
  modelInfo: p.modelInfo,
  seoTitle: p.seoTitle,
  seoDescription: p.seoDescription,
});

// ---- products -------------------------------------------------------------------------------------

/** Create a draft product with its first variants and opening stock (permission catalog.edit). */
export async function createProductAdmin(
  db: Db,
  actor: AdminActor,
  rawInput: CreateProductAdminInput,
): Promise<{ productId: string; variantIds: string[] }> {
  assertCan(actor, 'catalog.edit');
  const input = parseOrThrow(createProductInput, {
    ...rawInput,
    slug: rawInput.slug || slugify(rawInput.name ?? ''),
  });
  const { variants, ...fields } = input;
  const skus = new Set<string>();
  for (const v of variants) {
    if (skus.has(v.sku)) throw fieldError('sku', `SKU ${v.sku} is used twice in this product`);
    skus.add(v.sku);
  }
  return inTx(db, async (tx) => {
    await assertReferences(tx, fields);
    await assertSlugFree(tx, fields.slug);
    for (const v of variants) await assertSkuFree(tx, v.sku);
    const [p] = await tx
      .insert(product)
      .values({ ...fields, status: 'draft' })
      .returning();
    if (!p) throw new Error('product insert failed');
    const variantIds: string[] = [];
    for (const [i, v] of variants.entries()) {
      const { stock, ...vf } = v;
      const [row] = await tx
        .insert(variant)
        .values({ ...vf, compareAtPaise: vf.compareAtPaise ?? null, productId: p.id, position: i })
        .returning({ id: variant.id });
      if (!row) throw new Error('variant insert failed');
      await initStock(tx, row.id, stock, actor.userId);
      variantIds.push(row.id);
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'product.create',
      entity: 'product',
      entityId: p.id,
      after: {
        ...productSnapshot(p),
        variants: variants.map((v) => ({ sku: v.sku, pricePaise: v.pricePaise, stock: v.stock })),
      },
    });
    return { productId: p.id, variantIds };
  });
}

/** Edit a product's descriptive fields (not status; see setProductStatus). Permission catalog.edit. */
export async function updateProduct(
  db: Db,
  actor: AdminActor,
  productId: string,
  rawInput: ProductFieldsInput,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const input = parseOrThrow(productFieldsInput, rawInput);
  await inTx(db, async (tx) => {
    const before = await lockProduct(tx, productId);
    await assertReferences(tx, input);
    if (input.slug !== before.slug) await assertSlugFree(tx, input.slug, productId);
    const [after] = await tx
      .update(product)
      .set(input)
      .where(eq(product.id, productId))
      .returning();
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'product.update',
      entity: 'product',
      entityId: productId,
      before: productSnapshot(before),
      after: productSnapshot(after!),
    });
  });
}

const statusInput = z.enum(PRODUCT_STATUSES);

/**
 * Publish, unpublish (back to draft) or archive a product (permission catalog.edit). A product can only be
 * published while it has at least one active variant. Archived products stay in past orders (INV-07).
 */
export async function setProductStatus(
  db: Db,
  actor: AdminActor,
  productId: string,
  rawStatus: ProductStatus,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const status = statusInput.parse(rawStatus);
  await inTx(db, async (tx) => {
    const before = await lockProduct(tx, productId);
    if (before.status === status) {
      throw new AppError('VALIDATION_FAILED', `This product is already ${status}.`);
    }
    if (status === 'published') {
      const [active] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(variant)
        .where(and(eq(variant.productId, productId), eq(variant.active, true)));
      if (!active || active.n === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Add at least one active variant before publishing.',
        );
      }
    }
    await tx.update(product).set({ status }).where(eq(product.id, productId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action:
        status === 'published'
          ? 'product.publish'
          : status === 'archived'
            ? 'product.archive'
            : 'product.unpublish',
      entity: 'product',
      entityId: productId,
      before: { status: before.status },
      after: { status },
    });
  });
}

/**
 * Delete a product (permission catalog.edit). A product that was never ordered is removed completely; one
 * that appears on any order is archived and hidden instead, so past orders stay intact (SPEC 4.10, INV-07).
 */
export async function deleteProduct(
  db: Db,
  actor: AdminActor,
  productId: string,
): Promise<{ mode: 'deleted' | 'archived' }> {
  assertCan(actor, 'catalog.edit');
  return inTx(db, async (tx) => {
    const before = await lockProduct(tx, productId);
    const ordered = await productEverOrdered(tx, productId);
    if (ordered) {
      await tx
        .update(product)
        .set({ status: 'archived', deletedAt: sql`now()` })
        .where(eq(product.id, productId));
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: 'product.delete',
        entity: 'product',
        entityId: productId,
        before: productSnapshot(before),
        after: { mode: 'archived', reason: 'product appears on past orders' },
      });
      return { mode: 'archived' as const };
    }
    const variants = await tx
      .select({ id: variant.id })
      .from(variant)
      .where(eq(variant.productId, productId));
    await purgeStock(
      tx,
      variants.map((v) => v.id),
    );
    await tx.delete(product).where(eq(product.id, productId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'product.delete',
      entity: 'product',
      entityId: productId,
      before: productSnapshot(before),
      after: { mode: 'deleted', variants: variants.length },
    });
    return { mode: 'deleted' as const };
  });
}

// ---- variants -------------------------------------------------------------------------------------

/** Add a variant with opening stock to an existing product (permission catalog.edit). */
export async function addVariant(
  db: Db,
  actor: AdminActor,
  productId: string,
  rawInput: NewVariantInput,
): Promise<{ variantId: string }> {
  assertCan(actor, 'catalog.edit');
  const input = parseOrThrow(newVariantInput, rawInput);
  return inTx(db, async (tx) => {
    await lockProduct(tx, productId);
    await assertSkuFree(tx, input.sku);
    const [pos] = await tx
      .select({ max: sql<number>`COALESCE(MAX(${variant.position}), -1)::int` })
      .from(variant)
      .where(eq(variant.productId, productId));
    const { stock, ...vf } = input;
    const [row] = await tx
      .insert(variant)
      .values({
        ...vf,
        compareAtPaise: vf.compareAtPaise ?? null,
        productId,
        position: (pos?.max ?? -1) + 1,
      })
      .returning();
    if (!row) throw new Error('variant insert failed');
    await initStock(tx, row.id, stock, actor.userId);
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'variant.create',
      entity: 'variant',
      entityId: row.id,
      after: {
        productId,
        sku: row.sku,
        optionValues: row.optionValues,
        pricePaise: row.pricePaise,
        compareAtPaise: row.compareAtPaise,
        stock,
      },
    });
    return { variantId: row.id };
  });
}

const variantSnapshot = (v: typeof variant.$inferSelect) => ({
  sku: v.sku,
  optionValues: v.optionValues,
  pricePaise: v.pricePaise,
  compareAtPaise: v.compareAtPaise,
  active: v.active,
});

async function lockVariant(tx: Tx, variantId: string) {
  const [row] = await tx.select().from(variant).where(eq(variant.id, variantId)).for('update');
  if (!row) throw new AppError('NOT_FOUND', 'Variant not found.');
  return row;
}

/** Edit SKU, options and prices of a variant (permission catalog.edit). Stock has its own action. */
export async function updateVariant(
  db: Db,
  actor: AdminActor,
  variantId: string,
  rawInput: VariantFieldsInput,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const input = parseOrThrow(variantFieldsInput, rawInput);
  await inTx(db, async (tx) => {
    const before = await lockVariant(tx, variantId);
    if (input.sku !== before.sku) await assertSkuFree(tx, input.sku, variantId);
    const [after] = await tx
      .update(variant)
      .set({ ...input, compareAtPaise: input.compareAtPaise ?? null })
      .where(eq(variant.id, variantId))
      .returning();
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'variant.update',
      entity: 'variant',
      entityId: variantId,
      before: variantSnapshot(before),
      after: variantSnapshot(after!),
    });
  });
}

/**
 * Deactivate (hide from the shop, keep for past orders and history) or reactivate a variant. A published
 * product must keep at least one active variant: unpublish it first to deactivate the last one.
 */
export async function setVariantActive(
  db: Db,
  actor: AdminActor,
  variantId: string,
  active: boolean,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  await inTx(db, async (tx) => {
    const v = await lockVariant(tx, variantId);
    if (v.active === active) {
      throw new AppError(
        'VALIDATION_FAILED',
        `This variant is already ${active ? 'active' : 'inactive'}.`,
      );
    }
    if (!active) {
      const p = await lockProduct(tx, v.productId);
      if (p.status === 'published') {
        const [others] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(variant)
          .where(
            and(
              eq(variant.productId, v.productId),
              eq(variant.active, true),
              ne(variant.id, variantId),
            ),
          );
        if (!others || others.n === 0) {
          throw new AppError(
            'VALIDATION_FAILED',
            'This is the last active variant of a published product. Unpublish the product first.',
          );
        }
      }
    }
    await tx.update(variant).set({ active }).where(eq(variant.id, variantId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: active ? 'variant.reactivate' : 'variant.deactivate',
      entity: 'variant',
      entityId: variantId,
      before: { active: v.active, sku: v.sku },
      after: { active },
    });
  });
}

// ---- media ----------------------------------------------------------------------------------------

const altInput = z.string().trim().max(200);

/**
 * Validate, re-encode and store an uploaded image, then attach it to the product (permission catalog.edit).
 * The object is written first and removed again if the database step fails.
 */
export async function uploadProductMedia(
  db: Db,
  actor: AdminActor,
  storage: ObjectStorage,
  input: { productId: string; bytes: Uint8Array; alt?: string },
): Promise<{ mediaId: string; objectKey: string; width: number; height: number }> {
  assertCan(actor, 'catalog.edit');
  const alt = altInput.parse(input.alt ?? '');
  const [p] = await db
    .select({ id: product.id, name: product.name })
    .from(product)
    .where(and(eq(product.id, input.productId), isNull(product.deletedAt)));
  if (!p) throw new AppError('NOT_FOUND', 'Product not found.');

  const image = await processImageUpload(input.bytes);
  const key = newMediaKey();
  await storage.put(key, image.data, image.contentType);
  try {
    return await inTx(db, async (tx) => {
      await lockProduct(tx, input.productId);
      const [pos] = await tx
        .select({ max: sql<number>`COALESCE(MAX(${productMedia.position}), -1)::int` })
        .from(productMedia)
        .where(eq(productMedia.productId, input.productId));
      const [row] = await tx
        .insert(productMedia)
        .values({
          productId: input.productId,
          objectKey: key,
          alt: alt || p.name,
          width: image.width,
          height: image.height,
          position: (pos?.max ?? -1) + 1,
        })
        .returning({ id: productMedia.id });
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: 'product.media_add',
        entity: 'product',
        entityId: input.productId,
        after: {
          mediaId: row!.id,
          objectKey: key,
          width: image.width,
          height: image.height,
          bytes: image.data.length,
        },
      });
      return { mediaId: row!.id, objectKey: key, width: image.width, height: image.height };
    });
  } catch (err) {
    await storage.remove(key).catch(() => undefined);
    throw err;
  }
}

export async function updateMediaAlt(
  db: Db,
  actor: AdminActor,
  mediaId: string,
  rawAlt: string,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const alt = altInput.min(1, 'Describe the image for screen readers').parse(rawAlt);
  await inTx(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(productMedia)
      .where(eq(productMedia.id, mediaId))
      .for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Image not found.');
    await tx.update(productMedia).set({ alt }).where(eq(productMedia.id, mediaId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'product.media_update',
      entity: 'product',
      entityId: before.productId,
      before: { mediaId, alt: before.alt },
      after: { mediaId, alt },
    });
  });
}

/**
 * Remove an image from a product (permission catalog.edit). The stored object is deleted after the database
 * change commits, when we created it and no other row still points at it.
 */
export async function removeProductMedia(
  db: Db,
  actor: AdminActor,
  storage: ObjectStorage | null,
  mediaId: string,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const orphan = await inTx(db, async (tx) => {
    const [row] = await tx
      .select()
      .from(productMedia)
      .where(eq(productMedia.id, mediaId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND', 'Image not found.');
    await lockProduct(tx, row.productId);
    await tx.delete(productMedia).where(eq(productMedia.id, mediaId));
    const rest = await tx
      .select({ id: productMedia.id, position: productMedia.position })
      .from(productMedia)
      .where(eq(productMedia.productId, row.productId))
      .orderBy(asc(productMedia.position), asc(productMedia.id));
    for (const [i, m] of rest.entries()) {
      if (m.position !== i)
        await tx.update(productMedia).set({ position: i }).where(eq(productMedia.id, m.id));
    }
    const [shared] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(productMedia)
      .where(eq(productMedia.objectKey, row.objectKey));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'product.media_remove',
      entity: 'product',
      entityId: row.productId,
      before: { mediaId, objectKey: row.objectKey, alt: row.alt },
    });
    return (shared?.n ?? 0) === 0 && isManagedMediaKey(row.objectKey) ? row.objectKey : null;
  });
  if (orphan && storage) await storage.remove(orphan).catch(() => undefined);
}

/** Set the display order of a product's images (first is the cover). Permission catalog.edit. */
export async function reorderProductMedia(
  db: Db,
  actor: AdminActor,
  productId: string,
  orderedIds: string[],
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const ids = z.array(z.uuid()).min(1).parse(orderedIds);
  await inTx(db, async (tx) => {
    await lockProduct(tx, productId);
    const current = await tx
      .select({ id: productMedia.id, position: productMedia.position })
      .from(productMedia)
      .where(eq(productMedia.productId, productId))
      .orderBy(asc(productMedia.position), asc(productMedia.id));
    const same =
      current.length === ids.length &&
      new Set(ids).size === ids.length &&
      current.every((m) => ids.includes(m.id));
    if (!same) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The image list changed. Reload the page and try again.',
      );
    }
    for (const [i, id] of ids.entries()) {
      await tx.update(productMedia).set({ position: i }).where(eq(productMedia.id, id));
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'product.media_reorder',
      entity: 'product',
      entityId: productId,
      before: { order: current.map((m) => m.id) },
      after: { order: ids },
    });
  });
}

// ---- collections and categories --------------------------------------------------------------------

/** Replace the set of collections a product belongs to (permission catalog.edit). */
export async function setProductCollections(
  db: Db,
  actor: AdminActor,
  productId: string,
  rawCollectionIds: string[],
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const wanted = [...new Set(z.array(z.uuid()).max(100).parse(rawCollectionIds))];
  await inTx(db, async (tx) => {
    await lockProduct(tx, productId);
    if (wanted.length) {
      const found = await tx
        .select({ id: collection.id })
        .from(collection)
        .where(inArray(collection.id, wanted));
      if (found.length !== wanted.length) {
        throw new AppError('VALIDATION_FAILED', 'One of the collections no longer exists.');
      }
    }
    const current = await tx
      .select({ collectionId: collectionProduct.collectionId })
      .from(collectionProduct)
      .where(eq(collectionProduct.productId, productId));
    const have = new Set(current.map((c) => c.collectionId));
    const toAdd = wanted.filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !wanted.includes(id));
    if (toRemove.length) {
      await tx
        .delete(collectionProduct)
        .where(
          and(
            eq(collectionProduct.productId, productId),
            inArray(collectionProduct.collectionId, toRemove),
          ),
        );
    }
    for (const id of toAdd) {
      const [pos] = await tx
        .select({ max: sql<number>`COALESCE(MAX(${collectionProduct.position}), -1)::int` })
        .from(collectionProduct)
        .where(eq(collectionProduct.collectionId, id));
      await tx
        .insert(collectionProduct)
        .values({ collectionId: id, productId, position: (pos?.max ?? -1) + 1 });
    }
    if (toAdd.length || toRemove.length) {
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: 'product.collections',
        entity: 'product',
        entityId: productId,
        before: { collectionIds: [...have].sort() },
        after: { collectionIds: [...wanted].sort() },
      });
    }
  });
}

async function assertNoCategoryCycle(tx: DbOrTx, categoryId: string, parentId: string | null) {
  let cursor = parentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === categoryId) throw fieldError('parentId', 'A category cannot sit inside itself');
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const [row] = await tx
      .select({ parentId: category.parentId })
      .from(category)
      .where(eq(category.id, cursor));
    cursor = row?.parentId ?? null;
  }
}

export async function createCategoryAdmin(
  db: Db,
  actor: AdminActor,
  rawInput: CategoryInput,
): Promise<{ categoryId: string }> {
  assertCan(actor, 'catalog.edit');
  const input = parseOrThrow(categoryInput, {
    ...rawInput,
    slug: rawInput.slug || slugify(rawInput.name ?? ''),
  });
  return inTx(db, async (tx) => {
    if (input.parentId) {
      const [p] = await tx
        .select({ id: category.id })
        .from(category)
        .where(eq(category.id, input.parentId));
      if (!p) throw fieldError('parentId', 'That parent category no longer exists');
    }
    const [dupe] = await tx
      .select({ id: category.id })
      .from(category)
      .where(eq(category.slug, input.slug));
    if (dupe) throw fieldError('slug', 'This slug is already in use');
    const [row] = await tx.insert(category).values(input).returning();
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'category.create',
      entity: 'category',
      entityId: row!.id,
      after: input,
    });
    return { categoryId: row!.id };
  });
}

export async function updateCategoryAdmin(
  db: Db,
  actor: AdminActor,
  categoryId: string,
  rawInput: CategoryInput,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const input = parseOrThrow(categoryInput, rawInput);
  await inTx(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(category)
      .where(eq(category.id, categoryId))
      .for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Category not found.');
    await assertNoCategoryCycle(tx, categoryId, input.parentId);
    if (input.slug !== before.slug) {
      const [dupe] = await tx
        .select({ id: category.id })
        .from(category)
        .where(eq(category.slug, input.slug));
      if (dupe) throw fieldError('slug', 'This slug is already in use');
    }
    await tx.update(category).set(input).where(eq(category.id, categoryId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'category.update',
      entity: 'category',
      entityId: categoryId,
      before: {
        name: before.name,
        slug: before.slug,
        parentId: before.parentId,
        position: before.position,
      },
      after: input,
    });
  });
}

/** Delete a category. Refused while it has sub-categories; products in it simply become uncategorised. */
export async function deleteCategoryAdmin(
  db: Db,
  actor: AdminActor,
  categoryId: string,
): Promise<{ productsUncategorised: number }> {
  assertCan(actor, 'catalog.edit');
  return inTx(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(category)
      .where(eq(category.id, categoryId))
      .for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Category not found.');
    const [kids] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(category)
      .where(eq(category.parentId, categoryId));
    if ((kids?.n ?? 0) > 0) {
      throw new AppError('VALIDATION_FAILED', 'Move or delete the sub-categories first.');
    }
    const [used] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(product)
      .where(eq(product.categoryId, categoryId));
    await tx.delete(category).where(eq(category.id, categoryId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'category.delete',
      entity: 'category',
      entityId: categoryId,
      before: { name: before.name, slug: before.slug },
      after: { productsUncategorised: used?.n ?? 0 },
    });
    return { productsUncategorised: used?.n ?? 0 };
  });
}

export async function createCollectionAdmin(
  db: Db,
  actor: AdminActor,
  rawInput: CollectionInput,
): Promise<{ collectionId: string }> {
  assertCan(actor, 'catalog.edit');
  const input = parseOrThrow(collectionInput, {
    ...rawInput,
    slug: rawInput.slug || slugify(rawInput.name ?? ''),
  });
  return inTx(db, async (tx) => {
    const [dupe] = await tx
      .select({ id: collection.id })
      .from(collection)
      .where(eq(collection.slug, input.slug));
    if (dupe) throw fieldError('slug', 'This slug is already in use');
    const [row] = await tx.insert(collection).values(input).returning();
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'collection.create',
      entity: 'collection',
      entityId: row!.id,
      after: input,
    });
    return { collectionId: row!.id };
  });
}

export async function updateCollectionAdmin(
  db: Db,
  actor: AdminActor,
  collectionId: string,
  rawInput: CollectionInput,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const input = parseOrThrow(collectionInput, rawInput);
  await inTx(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(collection)
      .where(eq(collection.id, collectionId))
      .for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Collection not found.');
    if (input.slug !== before.slug) {
      const [dupe] = await tx
        .select({ id: collection.id })
        .from(collection)
        .where(eq(collection.slug, input.slug));
      if (dupe) throw fieldError('slug', 'This slug is already in use');
    }
    await tx.update(collection).set(input).where(eq(collection.id, collectionId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'collection.update',
      entity: 'collection',
      entityId: collectionId,
      before: {
        name: before.name,
        slug: before.slug,
        description: before.description,
        position: before.position,
        published: before.published,
      },
      after: input,
    });
  });
}

/** Delete a collection. Products stay; only their membership of it is removed. */
export async function deleteCollectionAdmin(
  db: Db,
  actor: AdminActor,
  collectionId: string,
): Promise<{ membersRemoved: number }> {
  assertCan(actor, 'catalog.edit');
  return inTx(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(collection)
      .where(eq(collection.id, collectionId))
      .for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Collection not found.');
    const [members] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(collectionProduct)
      .where(eq(collectionProduct.collectionId, collectionId));
    await tx.delete(collection).where(eq(collection.id, collectionId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'collection.delete',
      entity: 'collection',
      entityId: collectionId,
      before: { name: before.name, slug: before.slug },
      after: { membersRemoved: members?.n ?? 0 },
    });
    return { membersRemoved: members?.n ?? 0 };
  });
}

// ---- admin reads ----------------------------------------------------------------------------------

export type AdminProductFilter = {
  q?: string;
  status?: ProductStatus;
  page?: number;
  pageSize?: number;
};

export type AdminProductRow = {
  id: string;
  slug: string;
  name: string;
  status: ProductStatus;
  categoryName: string | null;
  variantCount: number;
  minPricePaise: number | null;
  maxPricePaise: number | null;
  available: number;
  imageKey: string | null;
  imageAlt: string;
  updatedAt: Date;
};

const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');

/** Products for the admin table: search by name, slug or SKU, status filter, pagination (<= 100). */
export async function listProductsAdmin(db: DbOrTx, actor: AdminActor, f: AdminProductFilter = {}) {
  assertCan(actor, 'catalog.edit');
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const where: SQL[] = [sql`p.deleted_at IS NULL`];
  if (f.status && (PRODUCT_STATUSES as readonly string[]).includes(f.status)) {
    where.push(sql`p.status = ${f.status}`);
  }
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push(
      sql`(p.name ILIKE ${like} OR p.slug ILIKE ${like} OR EXISTS (SELECT 1 FROM variant sv WHERE sv.product_id = p.id AND sv.sku ILIKE ${like}))`,
    );
  }
  const whereSql = sql.join(where, sql` AND `);
  const from = sql`FROM product p
    LEFT JOIN category c ON c.id = p.category_id
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE v.active)::int AS variant_count,
             min(v.price_paise) FILTER (WHERE v.active)::bigint AS min_price,
             max(v.price_paise) FILTER (WHERE v.active)::bigint AS max_price,
             COALESCE(SUM(${availableQtySql(sql`v.id`)}) FILTER (WHERE v.active), 0)::int AS available
      FROM variant v WHERE v.product_id = p.id
    ) agg
    LEFT JOIN LATERAL (
      SELECT m.object_key, m.alt FROM product_media m
      WHERE m.product_id = p.id ORDER BY m.position, m.id LIMIT 1
    ) img ON true`;
  const rows = await db.execute<{
    id: string;
    slug: string;
    name: string;
    status: ProductStatus;
    category_name: string | null;
    variant_count: number;
    min_price: string | null;
    max_price: string | null;
    available: number;
    object_key: string | null;
    alt: string | null;
    updated_at: string | Date;
  }>(sql`SELECT p.id, p.slug, p.name, p.status, c.name AS category_name, agg.variant_count,
           agg.min_price, agg.max_price, agg.available, img.object_key, img.alt, p.updated_at
         ${from} WHERE ${whereSql}
         ORDER BY p.updated_at DESC, p.id
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  const countRes = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n ${from} WHERE ${whereSql}`,
  );
  const total = countRes.rows[0]?.n ?? 0;
  const items: AdminProductRow[] = rows.rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    categoryName: r.category_name,
    variantCount: r.variant_count,
    minPricePaise: r.min_price === null ? null : Number(r.min_price),
    maxPricePaise: r.max_price === null ? null : Number(r.max_price),
    available: r.available,
    imageKey: r.object_key,
    imageAlt: r.alt ?? '',
    updatedAt: new Date(r.updated_at),
  }));
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Everything the product edit page shows, or null for an unknown or deleted product. */
export async function getProductAdmin(db: DbOrTx, actor: AdminActor, productId: string) {
  assertCan(actor, 'catalog.edit');
  if (!z.uuid().safeParse(productId).success) return null;
  const [p] = await db
    .select()
    .from(product)
    .where(and(eq(product.id, productId), isNull(product.deletedAt)));
  if (!p) return null;
  const [variants, media, memberships, ordered] = await Promise.all([
    db
      .select({
        id: variant.id,
        sku: variant.sku,
        optionValues: variant.optionValues,
        pricePaise: variant.pricePaise,
        compareAtPaise: variant.compareAtPaise,
        active: variant.active,
        position: variant.position,
        onHand: sql<number>`${onHandQtySql(sql`${variant.id}`)}`,
        reserved: sql<number>`${reservedQtySql(sql`${variant.id}`)}`,
        available: sql<number>`${availableQtySql(sql`${variant.id}`)}`,
        lowStockThreshold: sql<number>`${lowStockThresholdSql(sql`${variant.id}`)}`,
      })
      .from(variant)
      .where(eq(variant.productId, productId))
      .orderBy(asc(variant.position), asc(variant.sku)),
    db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, productId))
      .orderBy(asc(productMedia.position), asc(productMedia.id)),
    db
      .select({ collectionId: collectionProduct.collectionId })
      .from(collectionProduct)
      .where(eq(collectionProduct.productId, productId)),
    productEverOrdered(db, productId),
  ]);
  return {
    product: p,
    variants: variants.map((v) => ({
      ...v,
      onHand: Number(v.onHand),
      reserved: Number(v.reserved),
      available: Number(v.available),
      lowStockThreshold: Number(v.lowStockThreshold),
    })),
    media,
    collectionIds: memberships.map((m) => m.collectionId),
    everOrdered: ordered,
  };
}

export async function listCategoriesAdmin(db: DbOrTx, actor: AdminActor) {
  assertCan(actor, 'catalog.edit');
  return db
    .select({
      id: category.id,
      name: category.name,
      slug: category.slug,
      parentId: category.parentId,
      position: category.position,
      productCount: sql<number>`(SELECT count(*)::int FROM product p WHERE p.category_id = ${category.id} AND p.deleted_at IS NULL)`,
    })
    .from(category)
    .orderBy(asc(category.position), asc(category.name));
}

export async function listCollectionsAdmin(db: DbOrTx, actor: AdminActor) {
  assertCan(actor, 'catalog.edit');
  return db
    .select({
      id: collection.id,
      name: collection.name,
      slug: collection.slug,
      description: collection.description,
      position: collection.position,
      published: collection.published,
      productCount: sql<number>`(SELECT count(*)::int FROM collection_product cp WHERE cp.collection_id = ${collection.id})`,
    })
    .from(collection)
    .orderBy(asc(collection.position), asc(collection.name));
}

/**
 * "Low stock" means: an active variant of a product that is not archived, whose available units (on hand minus
 * reserved) are at or below its threshold. The dashboard count and the inventory filter share this definition.
 */
const lowStockWhere = sql`v.active AND p.status <> 'archived' AND ${availableQtySql(sql`v.id`)} <= ${lowStockThresholdSql(sql`v.id`)}`;

export async function countLowStockVariants(db: DbOrTx, actor: AdminActor): Promise<number> {
  assertCan(actor, 'orders.view');
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM variant v JOIN product p ON p.id = v.product_id
        WHERE p.deleted_at IS NULL AND ${lowStockWhere}`,
  );
  return res.rows[0]?.n ?? 0;
}

export type AdminInventoryFilter = {
  q?: string;
  lowOnly?: boolean;
  page?: number;
  pageSize?: number;
};

/** Every variant with on hand, reserved, available and threshold (permission inventory.edit). */
export async function listInventoryAdmin(
  db: DbOrTx,
  actor: AdminActor,
  f: AdminInventoryFilter = {},
) {
  assertCan(actor, 'inventory.edit');
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const where: SQL[] = [sql`p.deleted_at IS NULL`];
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push(sql`(p.name ILIKE ${like} OR v.sku ILIKE ${like})`);
  }
  if (f.lowOnly) where.push(lowStockWhere);
  const whereSql = sql.join(where, sql` AND `);
  const from = sql`FROM variant v JOIN product p ON p.id = v.product_id`;
  const rows = await db.execute<{
    variant_id: string;
    sku: string;
    option_values: Record<string, string>;
    active: boolean;
    product_id: string;
    product_name: string;
    product_status: ProductStatus;
    on_hand: number;
    reserved: number;
    available: number;
    threshold: number;
  }>(sql`SELECT v.id AS variant_id, v.sku, v.option_values, v.active, p.id AS product_id,
           p.name AS product_name, p.status AS product_status,
           ${onHandQtySql(sql`v.id`)}::int AS on_hand,
           ${reservedQtySql(sql`v.id`)}::int AS reserved,
           ${availableQtySql(sql`v.id`)}::int AS available,
           ${lowStockThresholdSql(sql`v.id`)}::int AS threshold
         ${from} WHERE ${whereSql}
         ORDER BY lower(p.name), p.id, v.position, v.sku
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  const countRes = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n ${from} WHERE ${whereSql}`,
  );
  const total = countRes.rows[0]?.n ?? 0;
  const items = rows.rows.map((r) => ({
    variantId: r.variant_id,
    sku: r.sku,
    optionValues: r.option_values,
    active: r.active,
    productId: r.product_id,
    productName: r.product_name,
    productStatus: r.product_status,
    onHand: r.on_hand,
    reserved: r.reserved,
    available: r.available,
    threshold: r.threshold,
    low: r.available <= r.threshold,
  }));
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** One variant with its product name (for the stock history page), or null. */
export async function getVariantAdmin(db: DbOrTx, actor: AdminActor, variantId: string) {
  assertCan(actor, 'inventory.edit');
  if (!z.uuid().safeParse(variantId).success) return null;
  const [row] = await db
    .select({
      variantId: variant.id,
      sku: variant.sku,
      optionValues: variant.optionValues,
      productId: product.id,
      productName: product.name,
      onHand: sql<number>`${onHandQtySql(sql`${variant.id}`)}`,
      reserved: sql<number>`${reservedQtySql(sql`${variant.id}`)}`,
      available: sql<number>`${availableQtySql(sql`${variant.id}`)}`,
      threshold: sql<number>`${lowStockThresholdSql(sql`${variant.id}`)}`,
    })
    .from(variant)
    .innerJoin(product, eq(product.id, variant.productId))
    .where(eq(variant.id, variantId));
  if (!row) return null;
  return {
    ...row,
    onHand: Number(row.onHand),
    reserved: Number(row.reserved),
    available: Number(row.available),
    threshold: Number(row.threshold),
  };
}
