import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function PanelNotFound() {
  return (
    <section className="border border-line-strong bg-paper p-6">
      <h1 className="font-mono text-lg uppercase">404 · Not found</h1>
      <p className="mt-2 text-sm">That record does not exist, or it was removed.</p>
      <p className="mt-4">
        <Link href="/admin" className="admin-link text-sm">
          Back to the dashboard
        </Link>
      </p>
    </section>
  );
}
