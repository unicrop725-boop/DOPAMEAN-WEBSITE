import Script from 'next/script';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { listCollectionTiles, listProducts, parseListingQuery } from '@/modules/catalog';
import { HomeMarkup } from '@/storefront/home';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'DOPAMEAN | Responsive Page',
  alternates: { canonical: '/' },
};

// The original, unmodified stylesheets are linked (not bundled): see ADR 0004.
export default async function HomePage() {
  const db = getDb();
  const query = parseListingQuery({ pageSize: '10' }, { defaultSort: 'newest' });
  const [latest, collections] = await Promise.all([
    listProducts(db, { kind: 'all' }, query),
    listCollectionTiles(db, 2),
  ]);
  return (
    <>
      <link rel="stylesheet" href="/css/style.css" precedence="storefront" />
      <link rel="stylesheet" href="/css/responsive.css" precedence="storefront" />
      <HomeMarkup
        newArrivals={latest.items.slice(0, 4)}
        gridProducts={latest.items.slice(4, 10)}
        collections={collections}
      />
      <Script src="/js/storefront.js" strategy="afterInteractive" />
    </>
  );
}
