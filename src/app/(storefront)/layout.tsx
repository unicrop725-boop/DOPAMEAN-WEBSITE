import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { DEFAULT_FAVICON, getFaviconUrl } from '@/lib/banners';

// The site icon can be replaced in the admin (Banners and site icon), so it is read per request.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const icon = await getFaviconUrl(getDb()).catch(() => DEFAULT_FAVICON);
  return {
    title: 'DOPAMEAN',
    metadataBase: new URL(process.env.APP_URL ?? 'http://localhost:3000'),
    icons: { icon },
  };
}

// The storefront deliberately has no global stylesheet import: each ported page links the original,
// unmodified CSS files (served from /css) that the static site used for that page (ADR 0001).
export default function StorefrontRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
