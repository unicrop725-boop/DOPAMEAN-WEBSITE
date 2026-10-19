import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Postgres full-text search vector (generated column). */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const productStatus = pgEnum('product_status', ['draft', 'published', 'archived']);

export const category = pgTable('category', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentId: uuid('parent_id'),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const collection = pgTable('collection', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  position: integer('position').notNull().default(0),
  published: boolean('published').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const product = pgTable(
  'product',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    status: productStatus('status').notNull().default('draft'),
    categoryId: uuid('category_id').references(() => category.id, { onDelete: 'set null' }),
    /** HSN/SAC code printed on invoices and snapshotted on order lines. */
    hsnCode: text('hsn_code'),
    /** Weak reference to tax.tax_rule (modules never FK across each other's tables). */
    taxRuleId: uuid('tax_rule_id'),
    materials: text('materials'),
    careGuide: text('care_guide'),
    shippingReturns: text('shipping_returns'),
    /** e.g. "The model is 6'1, wearing size L." Shown on the product page when set. */
    modelInfo: text('model_info'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** Name weighted A, description weighted C. Query with websearch_to_tsquery('simple', ...). */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(name, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'C')`,
    ),
  },
  (t) => [
    index('product_status_idx').on(t.status),
    index('product_category_idx').on(t.categoryId),
    index('product_search_idx').using('gin', t.searchVector),
    index('product_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

export const collectionProduct = pgTable(
  'collection_product',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collection.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.productId] })],
);

export const variant = pgTable(
  'variant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    /** e.g. { "Size": "XL" } */
    optionValues: jsonb('option_values').$type<Record<string, string>>().notNull().default({}),
    /** Tax-inclusive unit price in paise. */
    pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
    compareAtPaise: bigint('compare_at_paise', { mode: 'number' }),
    active: boolean('active').notNull().default(true),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    uniqueIndex('variant_sku_uq').on(t.sku),
    index('variant_product_idx').on(t.productId),
    check('variant_price_positive', sql`${t.pricePaise} > 0`),
    check(
      'variant_compare_at_gt_price',
      sql`${t.compareAtPaise} IS NULL OR ${t.compareAtPaise} > ${t.pricePaise}`,
    ),
  ],
);

export const productMedia = pgTable(
  'product_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),
    /** Object key in S3-compatible storage, or an /assets path for seeded sample images. */
    objectKey: text('object_key').notNull(),
    alt: text('alt').notNull().default(''),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('product_media_product_idx').on(t.productId)],
);
