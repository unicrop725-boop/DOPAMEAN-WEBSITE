import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import {
  getFilterOptions,
  listProducts,
  parseListingQuery,
  resolveListing,
} from '@/modules/catalog';
import { ListingView } from '@/storefront/listing';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolveListing(getDb(), slug);
  return {
    title: resolved ? `${resolved.title} | DOPAMEAN` : 'Not found',
    alternates: { canonical: `/collections/${slug}` },
    icons: { icon: '/assets/Group 4.png' },
  };
}

export default async function CollectionPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const db = getDb();
  const resolved = await resolveListing(db, slug);
  if (!resolved) notFound();
  const query = parseListingQuery(await searchParams, { defaultSort: resolved.defaultSort });
  const [listing, options] = await Promise.all([
    listProducts(db, resolved.scope, query),
    getFilterOptions(db, resolved.scope),
  ]);
  return (
    <ListingView
      heading={resolved.title}
      basePath={`/collections/${slug}`}
      listing={listing}
      query={query}
      options={options}
      emptyMessage={
        query.sizes.length ||
        query.minPaise !== undefined ||
        query.maxPaise !== undefined ||
        query.inStock
          ? 'NO PRODUCTS MATCH THESE FILTERS.'
          : 'NO PRODUCTS HERE YET.'
      }
    />
  );
}
