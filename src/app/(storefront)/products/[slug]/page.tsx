import Script from 'next/script';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { getProductDetail, mediaUrl, type ProductDetail } from '@/modules/catalog';
import { ProductMarkup } from '@/storefront/product';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductDetail(getDb(), slug);
  if (!product) return { title: 'Not found' };
  const first = product.media[0];
  return {
    title: `${product.name} | DOPAMEAN`,
    description: product.description?.slice(0, 160),
    alternates: { canonical: `/products/${slug}` },
    openGraph: {
      title: product.name,
      description: product.description?.slice(0, 160),
      images: first ? [mediaUrl(first.objectKey)] : undefined,
    },
  };
}

/** schema.org Product + Offer (brief: Product structured data). Built from database values only. */
function jsonLd(product: ProductDetail, baseUrl: string) {
  const prices = product.variants.map((v) => v.pricePaise);
  const inStock = product.variants.some((v) => v.available > 0);
  const abs = (u: string) => (u.startsWith('http') ? u : `${baseUrl}${u}`);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description ?? undefined,
    sku: product.variants[0]?.sku,
    image: product.media.map((m) => abs(mediaUrl(m.objectKey))),
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'INR',
      lowPrice: (Math.min(...prices) / 100).toFixed(2),
      highPrice: (Math.max(...prices) / 100).toFixed(2),
      offerCount: product.variants.length,
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: `${baseUrl}/products/${product.slug}`,
    },
  };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const product = await getProductDetail(getDb(), slug);
  if (!product || product.variants.length === 0) notFound();
  const baseUrl = process.env.APP_URL ?? 'http://localhost:3000';
  // "<" is escaped so product text can never close the script element.
  const ld = JSON.stringify(jsonLd(product, baseUrl)).replace(/</g, '\\u003c');
  return (
    <>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;500;700&display=swap"
        precedence="storefront"
      />
      <link rel="stylesheet" href="/css/products.css" precedence="storefront" />
      <link rel="stylesheet" href="/css/product_responsive.css" precedence="storefront" />
      <link rel="stylesheet" href="/css/storefront-additions.css" precedence="storefront" />
      <ProductMarkup product={product} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ld }} />
      <Script src="/js/storefront.js" strategy="afterInteractive" />
    </>
  );
}
