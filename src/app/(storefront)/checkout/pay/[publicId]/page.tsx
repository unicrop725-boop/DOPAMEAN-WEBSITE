import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { getCheckoutDeps } from '@/lib/checkout-deps';
import { loadOrderPage } from '@/lib/order-page';
import { getSessionUser } from '@/lib/session';
import { getCustomerOrderDetail, getGuestOrderDetail } from '@/modules/orders';
import { Money, formatBracketPrice } from '@/modules/pricing';
import { PayLauncher } from '@/storefront/pay-launcher';
import { PageShell, PageTitle } from '@/storefront/shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Payment | DOPAMEAN',
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ publicId: string }>; searchParams: Promise<{ t?: string }> };

/** Pay (or retry paying) for an unpaid online order. Amount and provider order come from the database. */
export default async function PayPage({ params, searchParams }: Props) {
  const { publicId } = await params;
  const { t: token } = await searchParams;
  const db = getDb();
  const user = await getSessionUser();
  const detail = user
    ? await getCustomerOrderDetail(db, user.id, publicId)
    : token
      ? await getGuestOrderDetail(db, publicId, token)
      : null;
  if (!detail) notFound();

  const data = await loadOrderPage(db, detail);
  const orderHref = user
    ? `/account/orders/${publicId}`
    : `/orders/${publicId}?t=${encodeURIComponent(token ?? '')}`;
  if (!data.canPayNow || !data.payment?.providerOrderId) redirect(orderHref);

  const deps = await getCheckoutDeps();
  const o = detail.order;
  return (
    <PageShell>
      <div className="sp-narrow">
        <PageTitle>PAYMENT</PageTitle>
        {!deps.provider ? (
          <p role="alert" className="sp-message sp-message--error">
            Online payment is not available right now. Your order is saved; please contact us.
          </p>
        ) : (
          <PayLauncher
            keyId={deps.provider.publicKeyId}
            providerOrderId={data.payment.providerOrderId}
            amountPaise={o.totalPaise}
            orderNumber={o.number}
            publicId={o.publicId}
            token={user ? null : (token ?? null)}
            email={o.email}
            phone={o.phone}
            name={o.shippingAddress.fullName}
            totalLabel={formatBracketPrice(Money.of(o.totalPaise))}
          />
        )}
      </div>
    </PageShell>
  );
}
