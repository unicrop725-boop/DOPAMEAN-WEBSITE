import type { EmailMessage } from './templates';

/** Transactional order emails (brief: placed, paid, shipped, cancelled, refunded). Pure; money arrives pre-formatted. */
export type OrderEmailLine = { name: string; option: string; qty: number; totalLabel: string };

export type OrderEmailData = {
  to: string;
  customerName: string;
  orderNumber: number;
  totalLabel: string;
  lines: OrderEmailLine[];
  /** Link the customer can open to see the order. */
  orderUrl: string;
  paymentMethod: 'online' | 'cod';
};

const BRAND = 'DOPAMEAN';
const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function render(
  subject: string,
  title: string,
  intro: string[],
  d: OrderEmailData,
  extra: string[] = [],
  showLines = true,
): EmailMessage {
  const lineText = d.lines.map((l) => `- ${l.name} (${l.option}) x ${l.qty}  ${l.totalLabel}`);
  const text = [
    `Hi ${d.customerName || 'there'},`,
    '',
    ...intro,
    '',
    `Order #${d.orderNumber}`,
    ...(showLines ? lineText : []),
    ...(showLines ? [`Total: ${d.totalLabel}`] : []),
    ...(extra.length ? ['', ...extra] : []),
    '',
    `View your order: ${d.orderUrl}`,
    '',
    `- ${BRAND}`,
  ].join('\n');
  const lineHtml = d.lines
    .map(
      (l) =>
        `<tr><td style="padding:4px 12px 4px 0">${esc(l.name)}<br><span style="color:#555">${esc(l.option)} x ${l.qty}</span></td><td style="text-align:right">${esc(l.totalLabel)}</td></tr>`,
    )
    .join('');
  const html = `<div style="font-family:monospace;font-size:14px"><h2>${esc(title)}</h2><p>Hi ${esc(d.customerName || 'there')},</p>${intro.map((p) => `<p>${esc(p)}</p>`).join('')}<p><strong>Order #${d.orderNumber}</strong></p>${showLines ? `<table>${lineHtml}<tr><td style="padding-top:8px"><strong>Total</strong></td><td style="text-align:right;padding-top:8px"><strong>${esc(d.totalLabel)}</strong></td></tr></table>` : ''}${extra.map((p) => `<p>${esc(p)}</p>`).join('')}<p><a href="${esc(d.orderUrl)}">View your order</a></p><p>- ${BRAND}</p></div>`;
  return { to: d.to, subject, text, html };
}

export function orderPlacedEmail(d: OrderEmailData): EmailMessage {
  const intro =
    d.paymentMethod === 'cod'
      ? ['Thank you for your order. It is confirmed and you will pay cash on delivery.']
      : ['Thank you for your order. We will confirm it as soon as your payment is received.'];
  return render(`Order #${d.orderNumber} received`, 'Order received', intro, d);
}

export function orderPaidEmail(d: OrderEmailData): EmailMessage {
  return render(
    `Payment received for order #${d.orderNumber}`,
    'Payment received',
    ['We received your payment and your order is confirmed.'],
    d,
  );
}

export function orderShippedEmail(
  d: OrderEmailData & { carrier: string; trackingNo: string; trackingUrl?: string | null },
): EmailMessage {
  return render(
    `Order #${d.orderNumber} has shipped`,
    'Your order has shipped',
    ['Your order is on its way.'],
    d,
    [
      `Carrier: ${d.carrier}`,
      `Tracking number: ${d.trackingNo}`,
      ...(d.trackingUrl ? [`Track it: ${d.trackingUrl}`] : []),
    ],
    false,
  );
}

export function orderCancelledEmail(
  d: OrderEmailData & { reason?: string | null; refundNote?: string | null },
): EmailMessage {
  return render(
    `Order #${d.orderNumber} was cancelled`,
    'Order cancelled',
    ['Your order has been cancelled.', ...(d.reason ? [`Reason: ${d.reason}`] : [])],
    d,
    d.refundNote ? [d.refundNote] : [],
    false,
  );
}

export function orderRefundedEmail(d: OrderEmailData & { refundLabel: string }): EmailMessage {
  return render(
    `Refund for order #${d.orderNumber}`,
    'Refund issued',
    [
      `We refunded ${d.refundLabel} to your original payment method. It can take a few business days to appear.`,
    ],
    d,
    [],
    false,
  );
}

/** Internal alert to the shop (late payment auto-refunded, amount mismatch, refund failure ...). */
export function staffAlertEmail(input: {
  to: string;
  subject: string;
  lines: string[];
}): EmailMessage {
  return {
    to: input.to,
    subject: `[${BRAND} admin] ${input.subject}`,
    text: [...input.lines, '', `- ${BRAND} system`].join('\n'),
    html: `<div style="font-family:monospace;font-size:14px">${input.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`,
  };
}
