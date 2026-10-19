import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '@/db/client';
import { initStock } from '@/modules/inventory';
import { category, collection, collectionProduct, product, productMedia, variant } from './schema';

const variantInput = z.object({
  sku: z.string().min(1).max(64),
  optionValues: z.record(z.string(), z.string()).default({}),
  pricePaise: z.number().int().positive(),
  compareAtPaise: z.number().int().positive().nullish(),
  stock: z.number().int().min(0),
});

const productInput = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  categoryId: z.uuid().optional(),
  hsnCode: z.string().max(16).optional(),
  taxRuleId: z.uuid().optional(),
  materials: z.string().max(5000).optional(),
  careGuide: z.string().max(5000).optional(),
  shippingReturns: z.string().max(5000).optional(),
  modelInfo: z.string().max(300).optional(),
  variants: z.array(variantInput).min(1),
});
export type CreateProductInput = z.input<typeof productInput>;

/** Create a product with its variants and opening stock in the caller's transaction. */
export async function createProduct(
  tx: DbOrTx,
  rawInput: CreateProductInput,
  actorUserId?: string,
): Promise<{ productId: string; variantIds: string[] }> {
  const input = productInput.parse(rawInput);
  const { variants, ...fields } = input;
  const [p] = await tx.insert(product).values(fields).returning({ id: product.id });
  if (!p) throw new Error('product insert failed');
  const variantIds: string[] = [];
  for (const [i, v] of variants.entries()) {
    const { stock, ...vf } = v;
    const [row] = await tx
      .insert(variant)
      .values({ ...vf, compareAtPaise: vf.compareAtPaise ?? null, productId: p.id, position: i })
      .returning({ id: variant.id });
    if (!row) throw new Error('variant insert failed');
    await initStock(tx, row.id, stock, actorUserId);
    variantIds.push(row.id);
  }
  return { productId: p.id, variantIds };
}

export async function createCategory(
  tx: DbOrTx,
  input: { slug: string; name: string; parentId?: string; position?: number },
): Promise<string> {
  const [row] = await tx.insert(category).values(input).returning({ id: category.id });
  if (!row) throw new Error('category insert failed');
  return row.id;
}

export async function countProductsByStatus(
  db: DbOrTx,
): Promise<Record<'draft' | 'published' | 'archived', number>> {
  const rows = await db
    .select({ status: product.status, n: count() })
    .from(product)
    .groupBy(product.status);
  const out = { draft: 0, published: 0, archived: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function getProductBySlug(db: DbOrTx, slug: string) {
  const [row] = await db.select().from(product).where(eq(product.slug, slug)).limit(1);
  return row ?? null;
}

export * from './queries';
export {
  SORT_KEYS,
  SORT_LABELS,
  SIZE_ORDER,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  parseListingQuery,
  listingQueryString,
} from './domain/listing';
export type { SortKey, ListingQuery } from './domain/listing';

export async function createCollection(
  tx: DbOrTx,
  input: { slug: string; name: string; description?: string; position?: number },
): Promise<string> {
  const [row] = await tx.insert(collection).values(input).returning({ id: collection.id });
  if (!row) throw new Error('collection insert failed');
  return row.id;
}

export async function addToCollection(
  tx: DbOrTx,
  collectionId: string,
  productId: string,
  position: number,
): Promise<void> {
  await tx
    .insert(collectionProduct)
    .values({ collectionId, productId, position })
    .onConflictDoNothing();
}

export async function addProductMedia(
  tx: DbOrTx,
  productId: string,
  media: { objectKey: string; alt: string; width: number; height: number; position: number },
): Promise<void> {
  await tx.insert(productMedia).values({ productId, ...media });
}
