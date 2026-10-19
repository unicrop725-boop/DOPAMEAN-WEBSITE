import type { Metadata } from 'next';
import './admin.css';

export const metadata: Metadata = {
  title: { default: 'DOPAMEAN Admin', template: '%s | DOPAMEAN Admin' },
  robots: { index: false, follow: false },
};

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
