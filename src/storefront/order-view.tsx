import Link from 'next/link';
import { customerTimeline, STATUS_LABEL, type OrderPageData } from '@/lib/order-page';
import { mediaUrl } from '@/modules/catalog';
import { stateName } from '@/modules/customers';
import { Money, formatBracketPrice } from '@/modules/pricing';
import { cancelMyOrderAction } from '@/app/(storefront)/orders/actions';

const label = (paise: number) => formatBracketPrice(Money.of(paise));
const dateText = (d: Date) =>
  d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

const NOTICES: Record<string, { kind: 'success' | 'error'; text: string }> = {
  cancelled: {
    kind: 'success',
    text: 'Your order has been cancelled. Any payment will be refunded to your original payment method.',
  },
  'not-cancellable': {
    kind: 'error',
    text: 'This order can no longer be cancelled because it has already shipped.',
  },
};

/**
 * One order, from the database only: status, items (as snapshotted when it was placed), totals with the GST
 * split, delivery address, tracking and a plain-language timeline.
 */
export function OrderView({
  data,
  token,
  paid,
  notice,
}: {
  data: OrderPageData;
  /** Guest link secret; included in the cancel form for guests. */
  token?: string;
  /** Return-from-payment hint ("confirmed" | "pending" | "invalid"): only chooses a message, never the status. */
  paid?: string;
  notice?: string;
}) {
  const { detail, payment, refunds, shipments } = data;
  const o = detail.order;
  const cgst = detail.lines.reduce((s, l) => s + l.cgstPaise, 0);
  const sgst = detail.lines.reduce((s, l) => s + l.sgstPaise, 0);
  const igst = detail.lines.reduce((s, l) => s + l.igstPaise, 0);
  const note = notice ? NOTICES[notice] : undefined;
  const refunded = refunds
    .filter((r) => r.status === 'succeeded')
    .reduce((s, r) => s + r.amountPaise, 0);

  return (
    <div className="sp-wide">
      <h1 className="sp-title">[ ORDER #{o.number} ]</h1>
      <p className="sp-text sp-muted" style={{ marginTop: -10 }}>
        Placed {dateText(o.placedAt)}
      </p>

      {note && (
        <p
          role={note.kind === 'error' ? 'alert' : 'status'}
          className={`sp-message sp-message--${note.kind}`}
        >
          {note.text}
        </p>
      )}
      {paid === 'pending' && o.status === 'pending_payment' && (
        <p role="status" className="sp-message">
          We are still waiting for the bank to confirm your payment. This page shows the real
          status; refresh in a minute. If money was deducted it will be confirmed automatically or
          refunded.
        </p>
      )}
      {paid === 'invalid' && (
        <p role="alert" className="sp-message sp-message--error">
          We could not verify that payment response. Your order status below is what we have on
          record.
        </p>
      )}

      <div className="sp-grid-2" style={{ marginBottom: 18 }}>
        <div>
          <p className="sp-label sp-muted">Order</p>
          <p className="sp-text" style={{ margin: 0 }}>
            <span className="sp-badge sp-badge--status">{STATUS_LABEL[o.status]}</span>{' '}
            <span className="sp-badge sp-badge--status">{STATUS_LABEL[o.fulfillmentStatus]}</span>
          </p>
        </div>
        <div>
          <p className="sp-label sp-muted">Payment</p>
          <p className="sp-text" style={{ margin: 0 }}>
            {o.paymentMethod === 'cod' ? 'Cash on delivery' : 'Paid online'}:{' '}
            <span className="sp-badge sp-badge--status">
              {payment ? STATUS_LABEL[payment.status] : 'Pending'}
            </span>
          </p>
        </div>
      </div>

      {o.status === 'confirmed' && o.paymentMethod === 'cod' && payment?.status === 'pending' && (
        <p className="sp-message">
          Please keep {label(o.totalPaise)} ready to pay in cash when your order arrives.
        </p>
      )}
      {data.canPayNow && (
        <p className="sp-message">
          Your payment is not complete yet.{' '}
          <Link
            className="sp-link"
            href={`/checkout/pay/${o.publicId}${token ? `?t=${encodeURIComponent(token)}` : ''}`}
          >
            Complete payment
          </Link>
        </p>
      )}

      <h2 className="sp-subtitle">Items</h2>
      <table className="sp-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="num">
              Qty
            </th>
            <th scope="col" className="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((l) => (
            <tr key={l.id}>
              <td>
                <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {l.imageKey && (
                    <img
                      src={mediaUrl(l.imageKey)}
                      alt=""
                      width={44}
                      height={56}
                      style={{ objectFit: 'cover' }}
                    />
                  )}
                  <span>
                    {l.productName}
                    <br />
                    <span className="sp-muted">
                      {l.optionLabel.toUpperCase()} · {l.sku}
                    </span>
                  </span>
                </span>
              </td>
              <td className="num">{l.qty}</td>
              <td className="num">{label(l.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="sp-summary" style={{ maxWidth: 360, marginLeft: 'auto', marginTop: 14 }}>
        <div>
          <dt>Subtotal</dt>
          <dd>{label(o.subtotalPaise)}</dd>
        </div>
        {o.discountPaise > 0 && (
          <div>
            <dt>Discount</dt>
            <dd>- {label(o.discountPaise)}</dd>
          </div>
        )}
        <div>
          <dt>Shipping</dt>
          <dd>{o.shippingPaise === 0 ? 'FREE' : label(o.shippingPaise)}</dd>
        </div>
        {o.codFeePaise > 0 && (
          <div>
            <dt>Cash on delivery fee</dt>
            <dd>{label(o.codFeePaise)}</dd>
          </div>
        )}
        <div className="sp-summary-total">
          <dt>Total</dt>
          <dd>{label(o.totalPaise)}</dd>
        </div>
        <div className="sp-muted">
          <dt>GST included</dt>
          <dd>{label(o.taxPaise)}</dd>
        </div>
        {cgst + sgst > 0 && (
          <div className="sp-muted">
            <dt>CGST / SGST</dt>
            <dd>
              {label(cgst)} / {label(sgst)}
            </dd>
          </div>
        )}
        {igst > 0 && (
          <div className="sp-muted">
            <dt>IGST</dt>
            <dd>{label(igst)}</dd>
          </div>
        )}
        {refunded > 0 && (
          <div>
            <dt>Refunded</dt>
            <dd>{label(refunded)}</dd>
          </div>
        )}
      </dl>

      <h2 className="sp-subtitle">Delivery address</h2>
      <p className="sp-text" style={{ textTransform: 'none' }}>
        {o.shippingAddress.fullName}
        <br />
        {o.shippingAddress.line1}
        {o.shippingAddress.line2 ? `, ${o.shippingAddress.line2}` : ''}
        <br />
        {o.shippingAddress.city},{' '}
        {stateName(o.shippingAddress.stateCode) ?? o.shippingAddress.stateCode}{' '}
        {o.shippingAddress.pincode}
        <br />
        Phone: {o.shippingAddress.phone}
      </p>

      {shipments.length > 0 && (
        <>
          <h2 className="sp-subtitle">Tracking</h2>
          <ul className="sp-list">
            {shipments.map((s) => (
              <li key={s.id}>
                {s.carrier}:{' '}
                {s.trackingUrl ? (
                  <a
                    className="sp-link"
                    href={s.trackingUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {s.trackingNo}
                  </a>
                ) : (
                  s.trackingNo
                )}
                {s.deliveredAt && (
                  <span className="sp-badge">Delivered {dateText(s.deliveredAt)}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="sp-subtitle">Timeline</h2>
      <ol className="sp-timeline">
        {customerTimeline(detail).map((e, i) => (
          <li key={`${e.label}-${i}`}>
            {e.label} <span className="sp-muted">· {dateText(e.at)}</span>
          </li>
        ))}
      </ol>

      {data.cancellable && (
        <>
          <h2 className="sp-subtitle">Need to cancel?</h2>
          <details className="sp-box">
            <summary style={{ cursor: 'pointer' }}>Cancel this order</summary>
            <p className="sp-text" style={{ marginTop: 12 }}>
              This cancels the whole order.
              {payment && ['captured', 'partially_refunded'].includes(payment.status)
                ? ' Your payment will be refunded to your original payment method.'
                : ' You have not been charged.'}{' '}
              Orders that have shipped cannot be cancelled.
            </p>
            <form action={cancelMyOrderAction}>
              <input type="hidden" name="publicId" value={o.publicId} />
              {token && <input type="hidden" name="token" value={token} />}
              <button className="sp-btn sp-btn--danger" type="submit">
                Yes, cancel my order
              </button>
            </form>
          </details>
        </>
      )}
    </div>
  );
}
