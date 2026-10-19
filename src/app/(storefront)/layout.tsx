import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'DOPAMEAN',
  metadataBase: new URL(process.env.APP_URL ?? 'http://localhost:3000'),
};

// The storefront deliberately has no global stylesheet import: each ported page links the original,
// unmodified CSS files (served from /css) that the static site used for that page (ADR 0001).
export default function StorefrontRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
