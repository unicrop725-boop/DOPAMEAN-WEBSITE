import Link from 'next/link';
import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { readCartOwner } from '@/lib/cart-owner';
import { getCartView } from '@/lib/cart-service';
import { getEnv } from '@/lib/env';
import { PageShell, PageTitle } from '@/storefront/shell';
import { changeQtyAction, dropUnavailableAction, removeLineAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Shopping bag | DOPAMEAN', robots: { index: false } };

const MESSAGES: Record<string, string> = {
  QTY_EXCEEDS_AVAILABLE: 'Sorry, we do not have that many in stock.',
  OUT_OF_STOCK: 'Sorry, that item is sold out.',
  PRODUCT_UNAVAILABLE: 'That item is no longer available.',
  VALIDATION_FAILED: 'Something was not right with that request.',
};

type Props = { searchParams: Promise<{ error?: string }> };

export default async function CartPage({ searchParams }: Props) {
  const { error } = await searchParams;
  const view = await getCartView(getDb(), getEnv().PRICING_TOKEN_SECRET, await readCartOwner());

  return (
    <PageShell>
      <div className="sp-wide sp-cart-wrap">
        <PageTitle>SHOPPING BAG [{String(view.count).padStart(2, '0')}]</PageTitle>
        {error && (
          <p role="alert" className="sp-message sp-message--error">
            {MESSAGES[error] ?? 'We could not update your bag.'}
          </p>
        )}
        {view.removedCount > 0 && (
          <form
            action={dropUnavailableAction}
            className="sp-message sp-message--error"
            role="alert"
          >
            {view.removedCount} item{view.removedCount === 1 ? ' is' : 's are'} no longer available.{' '}
            <button type="submit" className="sp-link" style={{ font: 'inherit' }}>
              Remove {view.removedCount === 1 ? 'it' : 'them'}
            </button>
          </form>
        )}

        {view.lines.length === 0 ? (
          <div className="sp-empty">
            <p className="sp-text" style={{ margin: '0 auto 14px' }}>
              Your bag is empty.
            </p>
            <Link className="sp-btn" href="/collections/all">
              Shop now
            </Link>
          </div>
        ) : (
          <div className="sp-cart">
            <ul className="sp-cart-lines" aria-label="Items in your bag">
              {view.lines.map((l) => {
                const href = `/products/${l.productSlug}`;
                return (
                  <li key={l.variantId} className="sp-cart-line">
                    <Link className="sp-cart-imgbox" href={href} tabIndex={-1} aria-hidden="true">
                      {l.imageUrl ? (
                        <img className="sp-cart-img" src={l.imageUrl} alt="" />
                      ) : (
                        <span className="sp-cart-img" />
                      )}
                    </Link>
                    <div className="sp-cart-info">
                      <p className="sp-cart-name">
                        <Link href={href}>{l.name}</Link>
                      </p>
                      <p className="sp-cart-price">{l.unitLabel}</p>
                      <ul className="sp-cart-opts" aria-label="Options">
                        {l.optionLabel.split(', ').map((o) => (
                          <li key={o}>{o.toUpperCase()}</li>
                        ))}
                      </ul>
                      {!l.inStock && (
                        <p role="alert" className="sp-cart-stock">
                          {l.available === 0
                            ? 'Sold out.'
                            : `Only ${l.available} left. Reduce the quantity to continue.`}
                        </p>
                      )}
                      <div className="sp-cart-qtyrow">
                        <span className="sp-cart-qtylabel">Quantity:</span>
                        <form
                          action={changeQtyAction}
                          className="sp-qty"
                          aria-label={`Quantity for ${l.name}`}
                        >
                          <input type="hidden" name="variantId" value={l.variantId} />
                          <input type="hidden" name="qty" value={l.qty} />
                          <button
                            name="delta"
                            value="-1"
                            aria-label="Decrease quantity"
                            type="submit"
                          >
                            &minus;
                          </button>
                          <span className="sp-qty-n" aria-live="polite">
                            {l.qty}
                          </span>
                          <button
                            name="delta"
                            value="1"
                            aria-label="Increase quantity"
                            type="submit"
                            disabled={l.qty >= l.maxQty}
                          >
                            +
                          </button>
                        </form>
                        <p className="sp-cart-total">{l.lineTotalLabel}</p>
                      </div>
                    </div>
                    <form action={removeLineAction} className="sp-cart-x">
                      <input type="hidden" name="variantId" value={l.variantId} />
                      <button type="submit" aria-label={`Remove ${l.name}`} title="Remove">
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                          <path
                            d="M5 5l14 14M19 5L5 19"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>

            <aside className="sp-cart-summary" aria-label="Order summary">
              <dl className="sp-summary">
                <div>
                  <dt>Subtotal</dt>
                  <dd>{view.subtotalLabel}</dd>
                </div>
                <div>
                  <dt>Shipping</dt>
                  <dd>{view.shippingLabel}</dd>
                </div>
                {/* Last in the markup, shown first (see .sp-cart-summary .sp-summary-total). */}
                <div className="sp-summary-total">
                  <dt>Total</dt>
                  <dd>{view.totalLabel}</dd>
                </div>
              </dl>
              <p className="sp-field-hint">Prices include GST ({view.taxLabel}).</p>
              {view.freeShippingNote && <p className="sp-field-hint">{view.freeShippingNote}</p>}
              <div className="sp-cart-actions">
                {view.hasBlockingIssue ? (
                  <span className="sp-btn sp-cart-checkout" aria-disabled="true">
                    Secure checkout
                  </span>
                ) : (
                  <Link className="sp-btn sp-cart-checkout" href="/checkout">
                    Secure checkout
                  </Link>
                )}
                <Link className="sp-btn sp-btn--outline" href="/collections/all">
                  Continue shopping
                </Link>
              </div>
            </aside>
          </div>
        )}
      </div>
    </PageShell>
  );
}
