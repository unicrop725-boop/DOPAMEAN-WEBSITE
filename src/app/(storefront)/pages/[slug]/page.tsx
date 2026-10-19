import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { getContentPage } from '@/lib/content';
import { parseContent } from '@/lib/content-format';
import { ContactForm } from '@/storefront/contact-form';
import { PageShell, PageTitle } from '@/storefront/shell';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await getContentPage(getDb(), slug);
  return {
    title: page ? `${page.title} | DOPAMEAN` : 'Not found',
    alternates: { canonical: `/pages/${slug}` },
  };
}

export default async function ContentPage({ params }: Props) {
  const { slug } = await params;
  const page = await getContentPage(getDb(), slug);
  if (!page) notFound();
  const blocks = parseContent(page.body);
  return (
    <PageShell>
      <div className="sp-medium sp-prose">
        <PageTitle>{page.title.toUpperCase()}</PageTitle>
        {blocks.map((b, i) =>
          b.type === 'h2' ? (
            <h2 key={i}>{b.text}</h2>
          ) : b.type === 'ul' ? (
            <ul key={i} className="sp-text">
              {b.items.map((item, k) => (
                <li key={k}>{item}</li>
              ))}
            </ul>
          ) : (
            <p key={i} className="sp-text">
              {b.text}
            </p>
          ),
        )}
        {slug === 'contact' && <ContactForm />}
      </div>
    </PageShell>
  );
}
