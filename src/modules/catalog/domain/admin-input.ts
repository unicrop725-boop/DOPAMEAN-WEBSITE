import { z } from 'zod';

/** Input rules for catalog admin (plain TypeScript + zod, no framework or database imports). */

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter a URL slug')
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens');

/** Optional text: blank becomes null so a cleared field really clears the column. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .nullish()
    .transform((v) => (v ? v : null));

const optionalUuid = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null))
  .pipe(z.uuid('Pick a valid option').nullable());

export const productFieldsInput = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  slug: slugField,
  description: optionalText(10_000),
  categoryId: optionalUuid,
  hsnCode: optionalText(16),
  taxRuleId: optionalUuid,
  materials: optionalText(5000),
  careGuide: optionalText(5000),
  shippingReturns: optionalText(5000),
  modelInfo: optionalText(300),
  seoTitle: optionalText(200),
  seoDescription: optionalText(400),
});
export type ProductFieldsInput = z.input<typeof productFieldsInput>;
export type ProductFields = z.output<typeof productFieldsInput>;

const paise = (label: string) =>
  z
    .number({ error: `${label} must be an amount` })
    .int(`${label} must be a whole number of paise`)
    .min(1, `${label} must be more than zero`)
    .max(100_000_000, `${label} is too large`);

const optionValues = z
  .record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(60))
  .default({});

/** Compare-at (the struck-through price) must be higher than the price, matching the database CHECK. */
function checkComparePrice(
  v: { pricePaise: number; compareAtPaise?: number | null },
  ctx: z.RefinementCtx,
) {
  if (v.compareAtPaise != null && v.compareAtPaise <= v.pricePaise) {
    ctx.addIssue({
      code: 'custom',
      path: ['compareAtPaise'],
      message: 'Compare-at price must be higher than the price',
    });
  }
}

export const variantFieldsInput = z
  .object({
    sku: z
      .string()
      .trim()
      .min(1, 'Enter a SKU')
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'SKU may use letters, numbers, dot, dash, underscore'),
    optionValues,
    pricePaise: paise('Price'),
    compareAtPaise: paise('Compare-at price').nullish(),
  })
  .superRefine(checkComparePrice);
export type VariantFieldsInput = z.input<typeof variantFieldsInput>;

export const newVariantInput = z
  .object({
    sku: variantFieldsInput.shape.sku,
    optionValues,
    pricePaise: paise('Price'),
    compareAtPaise: paise('Compare-at price').nullish(),
    stock: z
      .number({ error: 'Stock must be a number' })
      .int('Stock must be a whole number')
      .min(0)
      .max(1_000_000),
  })
  .superRefine(checkComparePrice);
export type NewVariantInput = z.input<typeof newVariantInput>;

export const createProductInput = productFieldsInput.extend({
  variants: z.array(newVariantInput).min(1, 'Add at least one variant').max(100),
});
export type CreateProductAdminInput = z.input<typeof createProductInput>;

export const categoryInput = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  slug: slugField,
  parentId: optionalUuid,
  position: z.number().int().min(0).max(10_000).default(0),
});
export type CategoryInput = z.input<typeof categoryInput>;

export const collectionInput = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  slug: slugField,
  description: optionalText(1000),
  position: z.number().int().min(0).max(10_000).default(0),
  published: z.boolean().default(true),
});
export type CollectionInput = z.input<typeof collectionInput>;

export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
