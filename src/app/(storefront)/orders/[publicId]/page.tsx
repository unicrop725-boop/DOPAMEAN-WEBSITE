import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { loadOrderPage } from '@/lib/order-page';
import { getSessionUser } from '@/lib/session';
import { getCustomerOrderDetail, getGuestOrderDetail } from '@/modules/orders';
import { OrderView } from '@/storefront/order-view';
import { PageShell } from '@/storefront/shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Your order | DOPAMEAN',
  robots: { index: false, follow: false },
};

type Props = {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ t?: string; paid?: string; notice?: string }>;
};

/**
 * Order page for guests, opened with the secret from the confirmation link. Signed-in owners are sent to
 * their account copy. The content is built from the database, not from anything in the URL (only the
 * secret is used, to authorise access).
 */
export default async function GuestOrderPage({ params, searchParams }: Props) {
  const { publicId } = await params;
  const sp = await searchParams;
  const db = getDb();

  const user = await getSessionUser();
  if (user && (await getCustomerOrderDetail(db, user.id, publicId))) {
    redirect(`/account/orders/${publicId}${sp.paid ? `?paid=${encodeURIComponent(sp.paid)}` : ''}`);
  }

  const detail = sp.t ? await getGuestOrderDetail(db, publicId, sp.t) : null;
  if (!detail) notFound();
  const data = await loadOrderPage(db, detail);
  return (
    <PageShell>
      <OrderView data={data} token={sp.t} paid={sp.paid} notice={sp.notice} />
    </PageShell>
  );
}
