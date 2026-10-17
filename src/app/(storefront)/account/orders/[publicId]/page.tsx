import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { loadOrderPage } from '@/lib/order-page';
import { requireUser } from '@/lib/session';
import { getCustomerOrderDetail } from '@/modules/orders';
import { OrderView } from '@/storefront/order-view';
import { PageShell } from '@/storefront/shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Order | DOPAMEAN',
  robots: { index: false, follow: false },
};

type Props = {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ paid?: string; notice?: string }>;
};

export default async function AccountOrderPage({ params, searchParams }: Props) {
  const { publicId } = await params;
  const sp = await searchParams;
  const user = await requireUser(`/account/orders/${publicId}`);
  // The owner id is part of the query (INV-13): another customer's order id is simply "not found".
  const detail = await getCustomerOrderDetail(getDb(), user.id, publicId);
  if (!detail) notFound();
  const data = await loadOrderPage(getDb(), detail);
  return (
    <PageShell>
      <OrderView data={data} paid={sp.paid} notice={sp.notice} />
    </PageShell>
  );
}
