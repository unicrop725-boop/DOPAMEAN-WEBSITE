import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { ActionForm, Field, FormMessage, SubmitButton } from '@/components/admin/forms';
import {
  Forbidden,
  FulfillmentBadge,
  Notice,
  OrderStatusBadge,
  PaymentBadge,
  Rupees,
  dateTime,
  rupeesText,
} from '@/components/admin/parts';
import { loadOrderPage } from '@/lib/admin/orders';
import { noticeText } from '@/lib/admin/notices';
import { gate, type SearchParams } from '@/lib/admin/page';
import { paiseToRupeeInput } from '@/lib/rupees';
import { stateName } from '@/modules/customers';
import { CARRIERS } from '@/modules/fulfillment';
import { can, lookupStaff } from '@/modules/staff';
import {
  cancelAction,
  collectCodAction,
  deliverAction,
  noteAction,
  refundAction,
  shipAction,
} from './actions';

export const metadata = { title: 'Order' };
export const dynamic = 'force-dynamic';

const EVENT_LABELS: Record<string, string> = {
  'order.placed': 'Order placed',
  'order.confirm': 'Payment confirmed, order confirmed',
  'order.ship': 'Marked as shipped',
  'order.deliver': 'Marked as delivered',
  'order.cancel': 'Order cancelled',
  'order.note': 'Internal note',
  'payment.captured': 'Payment captured',
  'payment.cod_collected': 'Cash on delivery collected',
  'refund.requested': 'Refund requested',
  'refund.succeeded': 'Refund succeeded',
  'refund.failed': 'Refund failed',
};

function payloadSummary(type: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.reason === 'string' && p.reason) parts.push(`Reason: ${p.reason}`);
  if (typeof p.amountPaise === 'number') parts.push(`Amount: ${rupeesText(p.amountPaise)}`);
  if (typeof p.totalPaise === 'number') parts.push(`Total: ${rupeesText(p.totalPaise)}`);
  if (typeof p.carrier === 'string') parts.push(`Carrier: ${p.carrier}`);
  if (typeof p.paymentMethod === 'string')
    parts.push(`Method: ${p.paymentMethod === 'cod' ? 'COD' : 'Online'}`);
  if (typeof p.message === 'string') parts.push(p.message);
  return type === 'order.note' ? null : parts.length ? parts.join(' · ') : null;
}

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('orders.view');
  if (!g.ok) return <Forbidden what="orders" reason={g.reason} />;
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const data = await loadOrderPage(db, g.admin, id);
  if (!data) notFound();
  const { order: o, lines, events, payment, attempts, refunds, shipments } = data;

  const staffIds = [
    ...events.map((e) => e.actor),
    ...refunds.map((r) => r.createdBy ?? ''),
    ...shipments.map((s) => s.createdBy ?? ''),
  ].filter(Boolean);
  const people = await lookupStaff(db, staffIds);
  const who = (actor: string | null) =>
    !actor
      ? 'system'
      : (people.get(actor)?.email ??
        (['system', 'customer', 'guest', 'provider'].includes(actor)
          ? actor
          : 'a customer or removed user'));

  const role = g.staff.role;
  const live = o.status === 'confirmed' || o.status === 'completed';
  const canShip =
    can(role, 'orders.ship') && o.status === 'confirmed' && o.fulfillmentStatus === 'unfulfilled';
  const canDeliver =
    can(role, 'orders.ship') && o.status === 'confirmed' && o.fulfillmentStatus === 'shipped';
  const canCollect =
    can(role, 'orders.ship') && o.paymentMethod === 'cod' && live && payment?.status === 'pending';
  const canCancel =
    can(role, 'orders.cancel') &&
    (o.status === 'pending_payment' || o.status === 'confirmed') &&
    o.fulfillmentStatus === 'unfulfilled';
  const refundable = payment ? payment.capturedPaise - payment.refundedPaise : 0;
  const canRefund =
    can(role, 'orders.refund') &&
    !!payment &&
    (payment.status === 'captured' || payment.status === 'partially_refunded') &&
    refundable > 0;
  const canNote = can(role, 'orders.note');

  const cgst = lines.reduce((n, l) => n + l.cgstPaise, 0);
  const sgst = lines.reduce((n, l) => n + l.sgstPaise, 0);
  const igst = lines.reduce((n, l) => n + l.igstPaise, 0);
  const addr = o.shippingAddress;
  const refundKey = randomUUID().replaceAll('-', '');

  return (
    <section aria-labelledby="page-title">
      <p className="mb-2 text-sm">
        <Link href="/admin/orders" className="admin-link">
          Orders
        </Link>{' '}
        / #{o.number}
      </p>
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 id="page-title" className="font-mono text-lg uppercase">
          Order #{o.number}
        </h1>
        <OrderStatusBadge status={o.status} />
        <FulfillmentBadge status={o.fulfillmentStatus} />
        <PaymentBadge status={payment?.status ?? null} />
        <span className="text-sm text-muted-text">Placed {dateTime(o.placedAt)}</span>
      </header>
      <Notice text={noticeText(sp.notice)} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="admin-card" aria-labelledby="items-h">
            <h2 id="items-h" className="admin-h2">
              Items (snapshot at purchase)
            </h2>
            <div className="overflow-x-auto">
              <table className="admin-table">
                <caption className="sr-only">Order lines with HSN code and tax</caption>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">HSN</th>
                    <th scope="col" className="num">
                      Qty
                    </th>
                    <th scope="col" className="num">
                      Unit
                    </th>
                    <th scope="col" className="num">
                      Discount
                    </th>
                    <th scope="col" className="num">
                      GST rate
                    </th>
                    <th scope="col" className="num">
                      GST
                    </th>
                    <th scope="col" className="num">
                      Line total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <th scope="row">
                        {l.productName}
                        <span className="block text-xs font-normal text-muted-text">
                          {l.optionLabel} · SKU {l.sku}
                        </span>
                      </th>
                      <td className="font-mono">{l.hsnCode ?? 'n/a'}</td>
                      <td className="num">{l.qty}</td>
                      <td className="num">
                        <Rupees paise={l.unitPaise} />
                      </td>
                      <td className="num">
                        <Rupees paise={l.discountPaise} />
                      </td>
                      <td className="num">
                        {(l.taxRateBp / 100).toFixed(2).replace(/\.00$/, '')}%
                      </td>
                      <td className="num">
                        <Rupees paise={l.taxPaise} />
                        <span className="block text-xs text-muted-text">
                          {l.igstPaise > 0
                            ? `IGST ${rupeesText(l.igstPaise)}`
                            : `CGST ${rupeesText(l.cgstPaise)} · SGST ${rupeesText(l.sgstPaise)}`}
                        </span>
                      </td>
                      <td className="num">
                        <Rupees paise={l.totalPaise} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="mt-4 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
              <dt>Subtotal (GST included)</dt>
              <dd className="text-right">
                <Rupees paise={o.subtotalPaise} />
              </dd>
              <dt>Discount</dt>
              <dd className="text-right">
                <Rupees paise={o.discountPaise} />
              </dd>
              <dt>Shipping</dt>
              <dd className="text-right">
                <Rupees paise={o.shippingPaise} />
              </dd>
              <dt>COD fee</dt>
              <dd className="text-right">
                <Rupees paise={o.codFeePaise} />
              </dd>
              <dt className="border-t border-line pt-1 font-semibold">Total</dt>
              <dd className="border-t border-line pt-1 text-right font-semibold">
                <Rupees paise={o.totalPaise} />
              </dd>
              <dt className="mt-2 text-muted-text">of which GST (total)</dt>
              <dd className="mt-2 text-right text-muted-text">
                <Rupees paise={o.taxPaise} />
              </dd>
              {igst > 0 ? (
                <>
                  <dt className="text-muted-text">IGST</dt>
                  <dd className="text-right text-muted-text">
                    <Rupees paise={igst} />
                  </dd>
                </>
              ) : (
                <>
                  <dt className="text-muted-text">CGST</dt>
                  <dd className="text-right text-muted-text">
                    <Rupees paise={cgst} />
                  </dd>
                  <dt className="text-muted-text">SGST</dt>
                  <dd className="text-right text-muted-text">
                    <Rupees paise={sgst} />
                  </dd>
                </>
              )}
            </dl>
          </section>

          <section className="admin-card" aria-labelledby="timeline-h">
            <h2 id="timeline-h" className="admin-h2">
              Timeline
            </h2>
            <ol className="flex flex-col gap-3">
              {events.map((e) => {
                const note =
                  e.type === 'order.note' ? (e.payload as { text?: string } | null)?.text : null;
                const extra = payloadSummary(e.type, e.payload);
                return (
                  <li key={e.id} className="border-l-2 border-line-strong pl-3">
                    <p className="text-sm">
                      <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
                      <span className="text-muted-text">
                        {' '}
                        · {dateTime(e.at)} · {who(e.actor)}
                      </span>
                    </p>
                    {extra && <p className="text-xs text-muted-text">{extra}</p>}
                    {note && (
                      <p className="mt-1 whitespace-pre-wrap border border-line bg-panel-alt p-2 text-sm">
                        {note}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
            {canNote && (
              <ActionForm
                action={noteAction.bind(null, o.id)}
                className="mt-4 border-t border-line pt-4"
                aria-label="Add a note"
              >
                <Field
                  name="text"
                  label="Internal note"
                  kind="textarea"
                  rows={3}
                  maxLength={2000}
                  hint="Only staff see notes. They cannot be edited or removed."
                  required
                />
                <div className="flex items-center gap-3">
                  <SubmitButton variant="outline" pendingLabel="Adding">
                    Add note
                  </SubmitButton>
                  <FormMessage />
                </div>
              </ActionForm>
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4" aria-label="Order details and actions">
          <section className="admin-card" aria-labelledby="actions-h">
            <h2 id="actions-h" className="admin-h2">
              Actions
            </h2>
            {!canShip && !canDeliver && !canCollect && !canCancel && !canRefund && (
              <p className="text-sm text-muted-text">
                {role === 'support'
                  ? 'Your role can view orders and add notes. Shipping, cancelling and refunds need a manager or owner.'
                  : 'No actions are available for this order in its current state.'}
              </p>
            )}
            <div className="flex flex-col gap-4">
              {canShip && (
                <ActionForm action={shipAction.bind(null, o.id)} aria-label="Mark as shipped">
                  <p className="font-mono text-xs uppercase">Mark shipped</p>
                  <Field
                    name="carrier"
                    label="Carrier"
                    kind="select"
                    defaultValue="Delhivery"
                    required
                    options={CARRIERS.map((c) => ({ value: c, label: c }))}
                  />
                  <Field
                    name="trackingNo"
                    label="Tracking number"
                    required
                    maxLength={60}
                    autoComplete="off"
                  />
                  <Field
                    name="trackingUrl"
                    label="Tracking link (optional)"
                    type="url"
                    placeholder="https://"
                    hint="Must start with https://"
                  />
                  <SubmitButton pendingLabel="Shipping">Mark as shipped</SubmitButton>
                  <FormMessage />
                </ActionForm>
              )}
              {canDeliver && (
                <ConfirmAction
                  action={deliverAction.bind(null, o.id)}
                  trigger="Mark delivered"
                  triggerVariant="default"
                  triggerSize="default"
                  title={`Mark order #${o.number} delivered?`}
                  description="The order becomes completed and the shipment is marked delivered. This cannot be undone."
                  confirmLabel="Mark delivered"
                />
              )}
              {canCollect && (
                <ConfirmAction
                  action={collectCodAction.bind(null, o.id)}
                  trigger="Collect COD payment"
                  title={`Record cash collected for order #${o.number}?`}
                  description={`You are confirming that ${rupeesText(o.totalPaise)} in cash was received. The payment becomes paid. This cannot be undone.`}
                  confirmLabel="Cash collected"
                />
              )}
              {canRefund && (
                <ConfirmAction
                  action={refundAction.bind(null, o.id)}
                  trigger="Refund"
                  title={`Refund order #${o.number}?`}
                  description={
                    <>
                      <p>
                        The amount below is sent back to the customer
                        {o.paymentMethod === 'cod'
                          ? ' as an offline refund that you record here (no payment provider is called)'
                          : ' through the payment provider'}
                        . The customer is emailed. A refund cannot be reversed.
                      </p>
                      <p className="mt-2">
                        Paid {rupeesText(payment!.capturedPaise)}, already refunded{' '}
                        {rupeesText(payment!.refundedPaise)}. The most you can refund now is{' '}
                        <strong>{rupeesText(refundable)}</strong>.
                      </p>
                    </>
                  }
                  confirmLabel="Issue refund"
                  pendingLabel="Refunding"
                  destructive
                  hidden={{ idempotencyKey: refundKey }}
                >
                  <Field
                    name="amount"
                    label="Amount (rupees)"
                    defaultValue={paiseToRupeeInput(refundable)}
                    inputMode="decimal"
                    required
                    hint="For example 499 or 499.50"
                  />
                  <Field
                    name="reason"
                    label="Reason"
                    kind="textarea"
                    rows={2}
                    required
                    maxLength={300}
                  />
                </ConfirmAction>
              )}
              {canCancel && (
                <ConfirmAction
                  action={cancelAction.bind(null, o.id)}
                  trigger="Cancel order"
                  triggerVariant="destructive"
                  title={`Cancel order #${o.number}?`}
                  description={
                    <>
                      <p>
                        The order is cancelled and its stock goes back on sale.{' '}
                        {payment && refundable > 0
                          ? `The customer is refunded ${rupeesText(refundable)} in full.`
                          : 'Nothing has been paid, so nothing is refunded.'}{' '}
                        The customer is emailed. A cancelled order cannot be reopened.
                      </p>
                    </>
                  }
                  confirmLabel="Cancel this order"
                  pendingLabel="Cancelling"
                  destructive
                >
                  <Field
                    name="reason"
                    label="Reason for cancelling"
                    kind="textarea"
                    rows={2}
                    required
                    maxLength={300}
                  />
                </ConfirmAction>
              )}
            </div>
          </section>

          <section className="admin-card" aria-labelledby="cust-h">
            <h2 id="cust-h" className="admin-h2">
              Customer and delivery
            </h2>
            <address className="text-sm not-italic">
              <strong>{addr.fullName}</strong>
              <br />
              {addr.line1}
              <br />
              {addr.line2 && (
                <>
                  {addr.line2}
                  <br />
                </>
              )}
              {addr.city}, {stateName(addr.stateCode) ?? addr.stateCode} {addr.pincode}
              <br />
              Phone {addr.phone}
              <br />
              <a className="admin-link" href={`mailto:${o.email}`}>
                {o.email}
              </a>
            </address>
            {o.customerId ? (
              can(role, 'customers.view') ? (
                <p className="mt-2 text-sm">
                  <Link className="admin-link" href={`/admin/customers/${o.customerId}`}>
                    View customer account
                  </Link>
                </p>
              ) : null
            ) : (
              <p className="mt-2 text-xs text-muted-text">Guest checkout (no account).</p>
            )}
          </section>

          <section className="admin-card" aria-labelledby="pay-h">
            <h2 id="pay-h" className="admin-h2">
              Payment
            </h2>
            {payment ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-text">Method</dt>
                  <dd>
                    {payment.method === 'cod'
                      ? 'Cash on delivery'
                      : `Online (${payment.provider ?? 'provider pending'})`}
                  </dd>
                  <dt className="text-muted-text">Status</dt>
                  <dd>
                    <PaymentBadge status={payment.status} />
                  </dd>
                  <dt className="text-muted-text">Amount due</dt>
                  <dd>
                    <Rupees paise={payment.amountPaise} />
                  </dd>
                  <dt className="text-muted-text">Captured</dt>
                  <dd>
                    <Rupees paise={payment.capturedPaise} />
                  </dd>
                  <dt className="text-muted-text">Refunded</dt>
                  <dd>
                    <Rupees paise={payment.refundedPaise} />
                  </dd>
                  <dt className="text-muted-text">Refundable</dt>
                  <dd>
                    <Rupees paise={refundable} />
                  </dd>
                </dl>
                {payment.status === 'needs_review' && (
                  <p
                    role="alert"
                    className="mt-2 border border-danger bg-danger-bg p-2 text-sm text-danger"
                  >
                    This payment was flagged for review (the provider and our records disagree).
                    Check it with the payment provider before taking any action.
                  </p>
                )}
                {attempts.length > 0 && (
                  <div className="mt-3 overflow-x-auto">
                    <table className="admin-table">
                      <caption className="admin-h2 mt-2 mb-1">Payment attempts</caption>
                      <thead>
                        <tr>
                          <th scope="col">When</th>
                          <th scope="col">Status</th>
                          <th scope="col">Provider payment</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attempts.map((a) => (
                          <tr key={a.id}>
                            <td className="whitespace-nowrap">{dateTime(a.createdAt)}</td>
                            <td>{a.status}</td>
                            <td className="font-mono text-xs">{a.providerPaymentId ?? 'none'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {refunds.length > 0 && (
                  <div className="mt-3 overflow-x-auto">
                    <table className="admin-table">
                      <caption className="admin-h2 mt-2 mb-1">Refunds</caption>
                      <thead>
                        <tr>
                          <th scope="col">When</th>
                          <th scope="col" className="num">
                            Amount
                          </th>
                          <th scope="col">Status</th>
                          <th scope="col">By</th>
                        </tr>
                      </thead>
                      <tbody>
                        {refunds.map((r) => (
                          <tr key={r.id}>
                            <td className="whitespace-nowrap">{dateTime(r.createdAt)}</td>
                            <td className="num">
                              <Rupees paise={r.amountPaise} />
                            </td>
                            <td>
                              {r.status}
                              {r.reason && (
                                <span className="block text-xs text-muted-text">{r.reason}</span>
                              )}
                            </td>
                            <td className="text-xs">{who(r.createdBy)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-text">No payment record exists for this order.</p>
            )}
          </section>

          <section className="admin-card" aria-labelledby="ship-h">
            <h2 id="ship-h" className="admin-h2">
              Shipments
            </h2>
            {shipments.length === 0 ? (
              <p className="text-sm text-muted-text">Nothing has been shipped yet.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {shipments.map((s) => (
                  <li key={s.id}>
                    <strong>{s.carrier}</strong> · {s.trackingNo}
                    {s.trackingUrl && (
                      <>
                        {' '}
                        ·{' '}
                        <a
                          className="admin-link"
                          href={s.trackingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Track (opens in a new tab)
                        </a>
                      </>
                    )}
                    <span className="block text-xs text-muted-text">
                      Shipped {dateTime(s.shippedAt)}
                      {s.deliveredAt ? ` · delivered ${dateTime(s.deliveredAt)}` : ''}
                      {s.createdBy ? ` · by ${who(s.createdBy)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
