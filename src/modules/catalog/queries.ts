import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { availableQtySql } from '@/modules/inventory';
import { category, collection, product, productMedia, variant } from './schema';
import { SIZE_ORDER, type ListingQuery } from './domain/listing';

export type ProductCard = {
  id: string;
  slug: string;
  name: string;
  minPricePaise: number;
  maxPricePaise: number;
  inStock: boolean;
  imageKey: string | null;
  imageAlt: string;
};

export type ListingScope =
  | { kind: 'all' }
  | { kind: 'category'; categoryId: string }
  | { kind: 'collection'; collectionId: string };

export type Listing = {
  items: ProductCard[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

const published = sql`p.status = 'published' AND p.deleted_at IS NULL`;

type Row = {
  id: string;
  slug: string;
  name: string;
  min_price: string | number;
  max_price: string | number;
  in_stock: boolean;
  object_key: string | null;
  alt: string | null;
};

function buildWhere(scope: ListingScope, q: ListingQuery): SQL[] {
  const where: SQL[] = [published, sql`agg.min_price IS NOT NULL`];
  if (scope.kind === 'category') where.push(sql`p.category_id = ${scope.categoryId}`);

  if (q.q) {
    where.push(
      sql`(p.search_vector @@ websearch_to_tsquery('simple', ${q.q}) OR word_similarity(${q.q}, p.name) >= 0.4 OR p.name ILIKE ${'%' + q.q.replace(/[%_\\]/g, '\\$&') + '%'})`,
    );
  }

  const variantConds: SQL[] = [];
  if (q.sizes.length) {
    variantConds.push(
      sql`v2.option_values->>'Size' IN (${sql.join(
        q.sizes.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  }
  if (q.minPaise !== undefined) variantConds.push(sql`v2.price_paise >= ${q.minPaise}`);
  if (q.maxPaise !== undefined) variantConds.push(sql`v2.price_paise <= ${q.maxPaise}`);
  if (q.inStock) variantConds.push(sql`${availableQtySql(sql`v2.id`)} > 0`);
  if (variantConds.length) {
    where.push(
      sql`EXISTS (SELECT 1 FROM variant v2 WHERE v2.product_id = p.id AND v2.active AND ${sql.join(variantConds, sql` AND `)})`,
    );
  }
  return where;
}

function fromClause(scope: ListingScope): SQL {
  const join =
    scope.kind === 'collection'
      ? sql`JOIN collection_product cp ON cp.product_id = p.id AND cp.collection_id = ${scope.collectionId}`
      : sql``;
  return sql`FROM product p
    ${join}
    CROSS JOIN LATERAL (
      SELECT min(v.price_paise)::bigint AS min_price,
             max(v.price_paise)::bigint AS max_price,
             COALESCE(bool_or(${availableQtySql(sql`v.id`)} > 0), false) AS in_stock
      FROM variant v WHERE v.product_id = p.id AND v.active
    ) agg
    LEFT JOIN LATERAL (
      SELECT m.object_key, m.alt FROM product_media m
      WHERE m.product_id = p.id ORDER BY m.position, m.id LIMIT 1
    ) img ON true`;
}

function orderBy(scope: ListingScope, q: ListingQuery): SQL {
  switch (q.sort) {
    case 'relevance':
      return sql`ORDER BY (ts_rank(p.search_vector, websearch_to_tsquery('simple', ${q.q ?? ''})) + word_similarity(${q.q ?? ''}, p.name)) DESC, p.id`;
    case 'price_asc':
      return sql`ORDER BY agg.min_price ASC, p.id`;
    case 'price_desc':
      return sql`ORDER BY agg.min_price DESC, p.id`;
    case 'name':
      return sql`ORDER BY lower(p.name) ASC, p.id`;
    case 'featured':
      return scope.kind === 'collection'
        ? sql`ORDER BY cp.position ASC, p.created_at DESC, p.id`
        : sql`ORDER BY p.created_at DESC, p.id`;
    default:
      return sql`ORDER BY p.created_at DESC, p.id`;
  }
}

/**
 * Paginated, filtered, sorted product listing for category/collection/all/search pages.
 * Always bounded (page size capped by parseListingQuery) and published-only.
 */
export async function listProducts(
  db: DbOrTx,
  scope: ListingScope,
  q: ListingQuery,
): Promise<Listing> {
  const where = sql.join(buildWhere(scope, q), sql` AND `);
  const from = fromClause(scope);
  const offset = (q.page - 1) * q.pageSize;

  const rows = await db.execute<Row>(
    sql`SELECT p.id, p.slug, p.name, agg.min_price, agg.max_price, agg.in_stock, img.object_key, img.alt
        ${from}
        WHERE ${where}
        ${orderBy(scope, q)}
        LIMIT ${q.pageSize} OFFSET ${offset}`,
  );
  const [countRow] = (
    await db.execute<{ n: string }>(sql`SELECT count(*)::bigint AS n ${from} WHERE ${where}`)
  ).rows;
  const total = Number(countRow?.n ?? 0);

  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      minPricePaise: Number(r.min_price),
      maxPricePaise: Number(r.max_price),
      inStock: r.in_stock,
      imageKey: r.object_key,
      imageAlt: r.alt ?? '',
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
    pageCount: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

export type ResolvedListing =
  | { kind: 'all'; slug: 'all'; title: string; scope: ListingScope; defaultSort: 'newest' }
  | { kind: 'new-in'; slug: 'new-in'; title: string; scope: ListingScope; defaultSort: 'newest' }
  | { kind: 'category'; slug: string; title: string; scope: ListingScope; defaultSort: 'newest' }
  | {
      kind: 'collection';
      slug: string;
      title: string;
      scope: ListingScope;
      defaultSort: 'featured';
    };

/** Map a /collections/[slug] URL segment to a listing scope, or null (404). */
export async function resolveListing(db: DbOrTx, slug: string): Promise<ResolvedListing | null> {
  if (slug === 'all') {
    return {
      kind: 'all',
      slug: 'all',
      title: 'Shop all',
      scope: { kind: 'all' },
      defaultSort: 'newest',
    };
  }
  if (slug === 'new-in') {
    return {
      kind: 'new-in',
      slug: 'new-in',
      title: 'New in',
      scope: { kind: 'all' },
      defaultSort: 'newest',
    };
  }
  const [cat] = await db.select().from(category).where(eq(category.slug, slug)).limit(1);
  if (cat) {
    return {
      kind: 'category',
      slug,
      title: cat.name,
      scope: { kind: 'category', categoryId: cat.id },
      defaultSort: 'newest',
    };
  }
  const [col] = await db
    .select()
    .from(collection)
    .where(and(eq(collection.slug, slug), eq(collection.published, true)))
    .limit(1);
  if (col) {
    return {
      kind: 'collection',
      slug,
      title: col.name,
      scope: { kind: 'collection', collectionId: col.id },
      defaultSort: 'featured',
    };
  }
  return null;
}

export type FilterOptions = {
  sizes: string[];
  priceMinPaise: number | null;
  priceMaxPaise: number | null;
};

/** Values to offer in the filter panel for a scope: sizes that exist and the price range. */
export async function getFilterOptions(db: DbOrTx, scope: ListingScope): Promise<FilterOptions> {
  const scopeJoin =
    scope.kind === 'collection'
      ? sql`JOIN collection_product cp ON cp.product_id = p.id AND cp.collection_id = ${scope.collectionId}`
      : sql``;
  const scopeWhere =
    scope.kind === 'category' ? sql`AND p.category_id = ${scope.categoryId}` : sql``;
  const res = await db.execute<{ size: string | null; min_price: string; max_price: string }>(
    sql`SELECT DISTINCT v.option_values->>'Size' AS size,
               min(v.price_paise) OVER ()::bigint AS min_price,
               max(v.price_paise) OVER ()::bigint AS max_price
        FROM product p ${scopeJoin}
        JOIN variant v ON v.product_id = p.id AND v.active
        WHERE ${published} ${scopeWhere}`,
  );
  const sizes = res.rows.map((r) => r.size).filter((s): s is string => !!s);
  sizes.sort((a, b) => {
    const ia = (SIZE_ORDER as readonly string[]).indexOf(a);
    const ib = (SIZE_ORDER as readonly string[]).indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const first = res.rows[0];
  return {
    sizes,
    priceMinPaise: first ? Number(first.min_price) : null,
    priceMaxPaise: first ? Number(first.max_price) : null,
  };
}

export type CollectionTile = {
  slug: string;
  name: string;
  productCount: number;
  imageKey: string | null;
  imageAlt: string;
};

/** Published collections for the home page tiles, with product counts and a cover image. */
export async function listCollectionTiles(db: DbOrTx, limit: number): Promise<CollectionTile[]> {
  const res = await db.execute<{
    slug: string;
    name: string;
    n: string;
    object_key: string | null;
    alt: string | null;
  }>(
    sql`SELECT c.slug, c.name,
               (SELECT count(*) FROM collection_product cp JOIN product p ON p.id = cp.product_id
                 WHERE cp.collection_id = c.id AND ${published}) AS n,
               img.object_key, img.alt
        FROM collection c
        LEFT JOIN LATERAL (
          SELECT m.object_key, m.alt FROM collection_product cp
          JOIN product p ON p.id = cp.product_id AND ${published}
          JOIN product_media m ON m.product_id = p.id
          WHERE cp.collection_id = c.id
          ORDER BY cp.position, m.position LIMIT 1
        ) img ON true
        WHERE c.published
        ORDER BY c.position, c.name
        LIMIT ${Math.min(limit, 20)}`,
  );
  return res.rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    productCount: Number(r.n),
    imageKey: r.object_key,
    imageAlt: r.alt ?? '',
  }));
}

export type ProductDetail = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  materials: string | null;
  careGuide: string | null;
  shippingReturns: string | null;
  modelInfo: string | null;
  hsnCode: string | null;
  variants: {
    id: string;
    sku: string;
    size: string | null;
    optionValues: Record<string, string>;
    pricePaise: number;
    compareAtPaise: number | null;
    available: number;
  }[];
  media: { objectKey: string; alt: string; width: number; height: number }[];
};

/** Published product with active variants (stock-aware) and media, or null. */
export async function getProductDetail(db: DbOrTx, slug: string): Promise<ProductDetail | null> {
  const [p] = await db
    .select()
    .from(product)
    .where(
      and(
        eq(product.slug, slug),
        eq(product.status, 'published'),
        sql`${product.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!p) return null;
  const variants = await db
    .select({
      id: variant.id,
      sku: variant.sku,
      optionValues: variant.optionValues,
      pricePaise: variant.pricePaise,
      compareAtPaise: variant.compareAtPaise,
      available: sql<number>`${availableQtySql(sql`${variant.id}`)}`,
    })
    .from(variant)
    .where(and(eq(variant.productId, p.id), eq(variant.active, true)))
    .orderBy(asc(variant.position));
  const media = await db
    .select({
      objectKey: productMedia.objectKey,
      alt: productMedia.alt,
      width: productMedia.width,
      height: productMedia.height,
    })
    .from(productMedia)
    .where(eq(productMedia.productId, p.id))
    .orderBy(asc(productMedia.position));
  const sizeIndex = (s: string | null) => {
    const i = (SIZE_ORDER as readonly string[]).indexOf(s ?? '');
    return i < 0 ? 99 : i;
  };
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    materials: p.materials,
    careGuide: p.careGuide,
    shippingReturns: p.shippingReturns,
    modelInfo: p.modelInfo,
    hsnCode: p.hsnCode,
    variants: variants
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        size: v.optionValues['Size'] ?? null,
        optionValues: v.optionValues,
        pricePaise: v.pricePaise,
        compareAtPaise: v.compareAtPaise,
        available: Number(v.available),
      }))
      .sort((a, b) => sizeIndex(a.size) - sizeIndex(b.size)),
    media,
  };
}

/** Published slugs for the sitemap. */
export async function listPublishedSlugs(db: DbOrTx): Promise<{ slug: string; updatedAt: Date }[]> {
  return db
    .select({ slug: product.slug, updatedAt: product.updatedAt })
    .from(product)
    .where(and(eq(product.status, 'published'), sql`${product.deletedAt} IS NULL`));
}

/** Public URL for a stored media key: seeded sample images are site paths, uploads live in S3. */
export function mediaUrl(key: string, s3PublicBase = process.env.S3_PUBLIC_URL): string {
  if (key.startsWith('/') || /^https?:\/\//.test(key)) return key;
  const base = (s3PublicBase ?? '').replace(/\/$/, '');
  return `${base}/${key}`;
}
