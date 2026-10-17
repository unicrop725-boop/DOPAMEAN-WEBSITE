import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { Forbidden, Notice, PageHeader } from '@/components/admin/parts';
import { getContentPageAdmin } from '@/lib/admin/content';
import { noticeText } from '@/lib/admin/notices';
import { gate, type SearchParams } from '@/lib/admin/page';
import { saveContentAction } from '../actions';
import { ContentEditor } from './content-editor';

export const metadata = { title: 'Edit page' };
export const dynamic = 'force-dynamic';

export default async function EditContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('catalog.edit');
  if (!g.ok) return <Forbidden what="content pages" reason={g.reason} />;
  const { slug } = await params;
  const sp = await searchParams;
  const page = await getContentPageAdmin(getDb(), g.admin, slug);
  if (!page) notFound();

  return (
    <section aria-labelledby="page-title">
      <p className="mb-2 text-sm">
        <Link href="/admin/content" className="admin-link">
          Content
        </Link>{' '}
        / {page.title}
      </p>
      <PageHeader
        title={page.title}
        description={
          <>
            Shown in the shop at <span className="font-mono">/pages/{page.slug}</span>.
            {page.isDefaultText && ' This is the starter text: saving makes the page live.'}
          </>
        }
      />
      <Notice text={noticeText(sp.notice)} />
      <ContentEditor
        action={saveContentAction.bind(null, page.slug)}
        title={page.title}
        body={page.body}
        published={page.published}
      />
    </section>
  );
}
