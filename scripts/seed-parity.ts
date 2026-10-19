// TEST-ONLY data (used by the E2E visual-parity suite, never by real seeding).
// Reads the ORIGINAL static pages in legacy/ and creates database rows that render the same content,
// so the data-bound pages can be pixel-compared against the originals.
//   npx tsx scripts/seed-parity.ts   (expects a migrated database)
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import sharp from 'sharp';
import { closeDb, getDb } from '../src/db/client';
import { product } from '../src/db/schema';
import {
  addProductMedia,
  addToCollection,
  createCategory,
  createCollection,
  createProduct,
} from '../src/modules/catalog';

type Item = { name: string; paise: number; image: string; alt: string };

function walk(nodes: ChildNode[], fn: (el: Element) => void) {
  for (const n of nodes) {
    if (n.type === 'tag') {
      fn(n as Element);
      walk((n as Element).children, fn);
    }
  }
}
const has = (el: Element, cls: string) => (el.attribs.class ?? '').split(/\s+/).includes(cls);
const text = (el: Element): string => {
  const t = (n: ChildNode): string =>
    n.type === 'text'
      ? (n as unknown as { data: string }).data
      : n.type === 'tag'
        ? (n as Element).children.map(t).join('')
        : '';
  return el.children.map(t).join('').replace(/\s+/g, ' ').trim();
};
const findAll = (root: ChildNode[], pred: (el: Element) => boolean): Element[] => {
  const out: Element[] = [];
  walk(root, (el) => pred(el) && out.push(el));
  return out;
};
const rupeesToPaise = (label: string) => Number(label.replace(/[^0-9]/g, '')) * 100;
const imgPath = (src: string) => src.replace(/^\.\//, '/');

function readCards(file: string, cardClass: string, nameClass: string, priceClass: string): Item[] {
  const doc = parseDocument(readFileSync(file, 'utf8'));
  return findAll(doc.children, (el) => has(el, cardClass)).map((card) => {
    const img = findAll(card.children, (e) => e.name === 'img')[0]!;
    const name = findAll(card.children, (e) => has(e, nameClass))[0]!;
    const price = findAll(card.children, (e) => has(e, priceClass))[0]!;
    return {
      name: text(name),
      paise: rupeesToPaise(text(price)),
      image: imgPath(img.attribs.src ?? ''),
      alt: img.attribs.alt ?? '',
    };
  });
}

async function dims(key: string) {
  const m = await sharp(`public${key}`).metadata();
  return { width: m.width ?? 800, height: m.height ?? 1000 };
}

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

async function main() {
  const db = getDb();

  // Original content, read from the static pages.
  const scroller = readCards(
    'legacy/index.html',
    'product-card',
    'product-card-name',
    'product-card-price',
  );
  const grid = readCards('legacy/index.html', 'item-card', 'item-name', 'item-price');
  const showcase = readCards(
    'legacy/collection_page.html',
    'product-item',
    'product-name',
    'product-price',
  );
  const tileDoc = parseDocument(readFileSync('legacy/index.html', 'utf8'));
  const tiles = findAll(tileDoc.children, (el) => has(el, 'collection-item')).map((el) => ({
    title: text(findAll(el.children, (e) => has(e, 'collection-title'))[0]!),
    image: imgPath(findAll(el.children, (e) => e.name === 'img')[0]!.attribs.src ?? ''),
  }));
  if (scroller.length !== 4 || grid.length !== 6 || showcase.length !== 16 || tiles.length !== 2) {
    throw new Error(
      `unexpected legacy structure: ${scroller.length}/${grid.length}/${showcase.length}/${tiles.length}`,
    );
  }

  const created: { id: string }[] = [];
  const categoryId = await createCategory(db, { slug: 'parity', name: 'Parity' });
  let n = 0;
  const make = async (item: Item, ageMinutes: number) => {
    n += 1;
    const { productId, variantIds } = await createProduct(db, {
      slug: `parity-${n}`,
      name: item.name,
      status: 'published',
      categoryId,
      variants: SIZES.map((size) => ({
        sku: `PAR-${n}-${size}`,
        optionValues: { Size: size },
        pricePaise: item.paise,
        stock: 10,
      })),
    });
    void variantIds;
    await addProductMedia(db, productId, {
      objectKey: item.image,
      alt: item.alt,
      ...(await dims(item.image)),
      position: 0,
    });
    // Control "newest first" ordering explicitly. Dated a day ahead so these always sort above the standard seed.
    await db
      .update(product)
      .set({ createdAt: sql`now() + interval '1 day' - make_interval(mins => ${ageMinutes})` })
      .where(eq(product.id, productId));
    created.push({ id: productId });
    return productId;
  };

  // Home: newest 4 = scroller (01 newest), next 6 = grid.
  for (const [i, item] of scroller.entries()) await make(item, i);
  for (const [i, item] of grid.entries()) await make(item, 10 + i);
  // Collection page: 16 products, manual order via collection position.
  const showcaseIds: string[] = [];
  for (const [i, item] of showcase.entries()) showcaseIds.push(await make(item, 100 + i));
  const showcaseCollection = await createCollection(db, {
    slug: 'showcase',
    name: 'Showcase',
    position: 99,
  });
  for (const [i, id] of showcaseIds.entries()) await addToCollection(db, showcaseCollection, id, i);

  // Home tiles: two collections of 15 products whose cover images are the original tile photos.
  const covers: string[] = [];
  for (const [i, tile] of tiles.entries()) {
    covers.push(
      await make(
        { name: `COVER ${i + 1}`, paise: 1_500_000, image: tile.image, alt: tile.title },
        200 + i,
      ),
    );
  }
  const pool = created.map((c) => c.id).filter((id) => !covers.includes(id));
  for (const [i, tile] of tiles.entries()) {
    const col = await createCollection(db, {
      slug: `parity-tile-${i + 1}`,
      name: tile.title,
      position: -2 + i,
    });
    await addToCollection(db, col, covers[i]!, 0);
    for (const [k, id] of pool.slice(0, 14).entries()) await addToCollection(db, col, id, k + 1);
  }

  // Product page: values taken from the original desktop markup.
  const pdoc = parseDocument(readFileSync('legacy/products.html', 'utf8'));
  const intro = text(findAll(pdoc.children, (e) => has(e, 'product-intro'))[0]!);
  const materials = findAll(
    findAll(pdoc.children, (e) => has(e, 'accordion-item'))[0]!.children,
    (e) => e.name === 'li',
  ).map(text);
  const pimgs = findAll(
    findAll(pdoc.children, (e) => has(e, 'product-image-scroller'))[0]!.children,
    (e) => e.name === 'img',
  ).map((i) => imgPath(i.attribs.src ?? ''));
  const { productId } = await createProduct(db, {
    slug: 'parity-product',
    name: 'PRODUCT NAME HERE',
    description: intro,
    status: 'published',
    categoryId,
    materials: materials.join('\n'),
    shippingReturns: 'Details about shipping and returns.',
    careGuide: 'Details about product care.',
    modelInfo: "THE MALE MODEL IS 6'15, WEARING SIZE L.",
    variants: SIZES.map((size) => ({
      sku: `PARP-${size}`,
      optionValues: { Size: size },
      pricePaise: 490_000,
      stock: 10,
    })),
  });
  for (const [i, key] of pimgs.entries()) {
    await addProductMedia(db, productId, {
      objectKey: key,
      alt: `view ${i + 1}`,
      ...(await dims(key)),
      position: i,
    });
  }
  console.log(`parity data created: ${created.length + 1} products, 3 collections`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
