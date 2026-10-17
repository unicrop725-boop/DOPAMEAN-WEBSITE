import Link from 'next/link';
import { getDb } from '@/db/client';
import { EmptyState, Forbidden, PageHeader, dateTime } from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { listContentPagesAdmin } from '@/lib/admin/content';
import { gate } from '@/lib/admin/page';

export const metadata = { title: 'Content' };
export const dynamic = 'force-dynamic';

export default async function ContentPage() {
  const g = await gate('catalog.edit');
  if (!g.ok) return <Forbidden what="content pages" reason={g.reason} />;
  const pages = await listContentPagesAdmin(getDb(), g.admin);

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Content"
        description="The footer pages of the shop (FAQ, shipping, legal). Text only: no HTML."
      />
      {pages.length === 0 ? (
        <EmptyState title="No pages" />
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="admin-table">
            <caption className="sr-only">Editable pages</caption>
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">Address</th>
                <th scope="col">State</th>
                <th scope="col">Last saved</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((p) => (
                <tr key={p.slug}>
                  <th scope="row">
                    <Link href={`/admin/content/${p.slug}`} className="admin-link">
                      {p.title}
                    </Link>
                  </th>
                  <td className="font-mono text-xs">/pages/{p.slug}</td>
                  <td>
                    {p.isDefaultText ? (
                      <Badge tone="warning">Starter text, not saved yet</Badge>
                    ) : p.published ? (
                      <Badge tone="success">Published</Badge>
                    ) : (
                      <Badge tone="muted">Unpublished</Badge>
                    )}
                  </td>
                  <td>{p.updatedAt ? dateTime(p.updatedAt) : 'Never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
