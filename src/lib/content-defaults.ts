/**
 * Starter text for the footer pages. These are NOT real policies: the shop owner must write them.
 * Only statements the original site already makes (free shipping, cash on delivery, Panipat) are used.
 * Every page opens with a visible notice so nothing here can pass for a published policy.
 */
const NOTICE =
  'This page has not been written yet. The shop owner needs to replace this placeholder text before launch.';

export type DefaultPage = { slug: string; title: string; body: string };

export const DEFAULT_CONTENT_PAGES: DefaultPage[] = [
  {
    slug: 'faq',
    title: 'FAQs',
    body: `${NOTICE}\n\n## Orders and payment\n\nCash on delivery is advertised on this site.\n\n## Shipping\n\nFree shipping on all orders is advertised on this site.`,
  },
  { slug: 'product-care', title: 'Product care', body: NOTICE },
  {
    slug: 'size-charts',
    title: 'Size charts',
    body: `${NOTICE}\n\nA size guide is also shown on each product page.`,
  },
  {
    slug: 'shipping',
    title: 'Shipping',
    body: `${NOTICE}\n\nFree shipping on all orders is advertised on this site.\n\nCash on delivery is available.`,
  },
  { slug: 'exchanges-returns', title: 'Exchanges and returns', body: NOTICE },
  {
    slug: 'gift-cards',
    title: 'Gift cards',
    body: 'Gift cards are not available at the moment.',
  },
  { slug: 'about', title: 'About', body: NOTICE },
  {
    slug: 'contact',
    title: 'Contact',
    body: 'Send us a message using the form below. We are based in Panipat, India.',
  },
  { slug: 'visit-us', title: 'Visit us', body: `${NOTICE}\n\nWe are based in Panipat, India.` },
  { slug: 'environmental-promises', title: 'Environmental promises', body: NOTICE },
  { slug: 'terms', title: 'Terms of service', body: NOTICE },
  { slug: 'privacy', title: 'Privacy policy', body: NOTICE },
];
