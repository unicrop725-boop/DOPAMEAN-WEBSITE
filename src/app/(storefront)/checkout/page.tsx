import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { readCartOwner } from '@/lib/cart-owner';
import { getCheckoutDeps } from '@/lib/checkout-deps';
import { getSessionUser } from '@/lib/session';
import { GST_STATES, listAddresses, stateName } from '@/modules/customers';
import { quoteCart } from '@/modules/checkout';
import { Money, formatBracketPrice } from '@/modules/pricing';
import { mediaUrl } from '@/modules/catalog';
import { CheckoutForm, type MethodSummary } from '@/storefront/checkout-form';
import { PageShell, PageTitle } from '@/storefront/shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Checkout | DOPAMEAN', robots: { index: false } };

const label = (paise: number) => formatBracketPrice(Money.of(paise));

export default async function CheckoutPage() {
  const owner = await readCartOwner();
  if (!owner) redirect('/cart');
  const deps = await getCheckoutDeps();
  const user = await getSessionUser();

  const saved = user ? await listAddresses(getDb(), user.id) : [];
  const defaultAddress = saved.find((a) => a.isDefault) ?? saved[0];
  const defaultState = defaultAddress?.stateCode ?? '06';

  const [cod, online] = await Promise.all([
    quoteCart(deps.db, deps.secret, owner, {
      destinationStateCode: defaultState,
      paymentMethod: 'cod',
    }),
    quoteCart(deps.db, deps.secret, owner, {
      destinationStateCode: defaultState,
      paymentMethod: 'online',
    }),
  ]);
  // Nothing to buy, or something is no longer sold or has run out: back to the bag, which explains why.
  if (
    online.quote.lines.length === 0 ||
    online.removedVariantIds.length > 0 ||
    online.quote.issues.some((i) => i.code === 'OUT_OF_STOCK')
  ) {
    redirect('/cart');
  }

  const summary = (cq: typeof cod, method: 'cod' | 'online'): MethodSummary => {
    const q = cq.quote;
    const codIssue = q.issues.find(
      (i) => i.code === 'COD_NOT_AVAILABLE' || i.code === 'COD_LIMIT_EXCEEDED',
    );
    let unavailableReason: string | null = null;
    if (method === 'cod' && codIssue) {
      unavailableReason =
        codIssue.code === 'COD_LIMIT_EXCEEDED'
          ? `Cash on delivery is available up to ${label(codIssue.maxPaise)}. Please pay online for this order.`
          : 'Cash on delivery is not available right now.';
    }
    if (method === 'online' && !deps.provider)
      unavailableReason = 'Online payment is not available right now.';
    return {
      token: cq.token,
      subtotalLabel: label(q.subtotalPaise),
      shippingLabel: q.shippingPaise === 0 ? 'FREE' : label(q.shippingPaise),
      taxLabel: label(q.taxPaise),
      totalLabel: label(q.totalPaise),
      unavailableReason,
    };
  };

  const summaries = { cod: summary(cod, 'cod'), online: summary(online, 'online') };
  const nothingAvailable =
    !!summaries.cod.unavailableReason && !!summaries.online.unavailableReason;

  return (
    <PageShell>
      <div className="sp-wide">
        <PageTitle>CHECKOUT</PageTitle>
        {nothingAvailable && (
          <p role="alert" className="sp-message sp-message--error">
            No payment method is available for this order right now. Please contact us.
          </p>
        )}
        <CheckoutForm
          email={user?.email ?? ''}
          phone={defaultAddress?.phone ?? ''}
          signedIn={!!user}
          savedAddresses={saved.map((a) => ({
            id: a.id,
            isDefault: a.isDefault,
            text: `${a.fullName}, ${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.city}, ${stateName(a.stateCode) ?? a.stateCode} ${a.pincode}`,
          }))}
          states={GST_STATES}
          defaultState={defaultState}
          lines={online.quote.lines.map((l) => ({
            name: l.name,
            option: l.optionLabel,
            qty: l.qty,
            totalLabel: label(l.totalPaise),
            imageUrl: l.imageKey ? mediaUrl(l.imageKey) : null,
          }))}
          summaries={summaries}
          initialKey={randomUUID().replaceAll('-', '')}
        />
      </div>
    </PageShell>
  );
}
