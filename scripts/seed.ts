// Fictional seed data (no real brand data, no real people). Safe to re-run:
// products are only created when none exist, footer pages are only inserted when missing.
//   npm run db:seed
import { count } from 'drizzle-orm';
import sharp from 'sharp';
import { closeDb, getDb } from '../src/db/client';
import { product } from '../src/db/schema';
import { ensureDefaultContentPages } from '../src/lib/content';
import {
  addProductMedia,
  addToCollection,
  createCategory,
  createCollection,
  createProduct,
} from '../src/modules/catalog';

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'] as const;
// Sample photos shipped with the original design (public/assets). Rights unconfirmed, see SPEC Q12.
const PHOTOS = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `/assets/product1 (${n}).png`);

const CATALOG: {
  cat: string;
  slug: string;
  items: { name: string; price: number; compareAt?: number }[];
}[] = [
  {
    cat: 'Top wear',
    slug: 'top-wear',
    items: [
      { name: 'Sample Oxford Shirt', price: 1_499_00 },
      { name: 'Sample Boxy Tee', price: 799_00, compareAt: 999_00 },
      { name: 'Sample Overshirt', price: 2_299_00 },
      { name: 'Sample Knit Polo', price: 1_199_00 },
    ],
  },
  {
    cat: 'Bottom wear',
    slug: 'bottom-wear',
    items: [
      { name: 'Sample Pleated Trouser', price: 1_899_00 },
      { name: 'Sample Cargo Short', price: 1_099_00, compareAt: 1_399_00 },
      { name: 'Sample Straight Denim', price: 2_499_00 },
    ],
  },
];

const COLLECTIONS = [
  { slug: 'essentials', name: 'Essentials', take: 4 },
  { slug: 'new-season', name: 'New season', take: 5 },
];

async function imageSize(key: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(`public${key}`).metadata();
  return { width: meta.width ?? 800, height: meta.height ?? 1000 };
}

async function main() {
  const db = getDb();
  const created = await ensureDefaultContentPages(db);
  if (created) console.log(`inserted ${created} starter footer pages`);

  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(product);
  if (n > 0) {
    console.log(`product seed skipped: ${n} products already exist`);
    await closeDb();
    return;
  }

  await db.transaction(async (tx) => {
    const productIds: string[] = [];
    let i = 0;
    for (const group of CATALOG) {
      const categoryId = await createCategory(tx, { slug: group.slug, name: group.cat });
      for (const item of group.items) {
        i += 1;
        const slug = item.name.toLowerCase().replaceAll(' ', '-');
        const { productId } = await createProduct(tx, {
          slug,
          name: item.name,
          description: 'Fictional sample product for development.',
          status: 'published',
          categoryId,
          hsnCode: '6205',
          materials: 'Sample materials text.',
          careGuide: 'Sample care guide text.',
          shippingReturns: 'Sample shipping and returns text.',
          variants: SIZES.map((size) => ({
            sku: `SMP-${String(i).padStart(3, '0')}-${size}`,
            optionValues: { Size: size },
            pricePaise: item.price,
            compareAtPaise: item.compareAt ?? null,
            stock: size === 'XXXL' && i === 1 ? 0 : 10,
          })),
        });
        productIds.push(productId);
        for (let m = 0; m < 3; m++) {
          const key = PHOTOS[(i + m) % PHOTOS.length]!;
          await addProductMedia(tx, productId, {
            objectKey: key,
            alt: `${item.name}, view ${m + 1}`,
            ...(await imageSize(key)),
            position: m,
          });
        }
      }
    }
    let position = 0;
    for (const c of COLLECTIONS) {
      const collectionId = await createCollection(tx, {
        slug: c.slug,
        name: c.name,
        position: position++,
      });
      for (const [k, productId] of productIds.slice(0, c.take).entries()) {
        await addToCollection(tx, collectionId, productId, k);
      }
    }
  });
  console.log('seeded categories, collections, products, variants, stock and media');
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
