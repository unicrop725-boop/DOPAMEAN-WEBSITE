import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * TEST-ONLY stand-in for api.razorpay.com so the real application code (the real adapter, the real webhook
 * route, the real return handler) can be exercised end to end in a browser without network access or keys.
 * The app talks to it through RAZORPAY_API_BASE. Control endpoints (/__*) let a test play the customer
 * (pay) and the provider (send a signed webhook).
 */
export const FAKE_RZP_PORT = Number(process.env.FAKE_RZP_PORT ?? 4010);
export const KEY_ID = 'rzp_test_e2e_key';
export const KEY_SECRET = 'e2e_key_secret_value';
export const WEBHOOK_SECRET = 'e2e_webhook_secret_value';

type Payment = { id: string; order_id: string; status: string; amount: number };

export function startFakeRazorpay(port = FAKE_RZP_PORT): Promise<Server> {
  const orders = new Map<string, { id: string; amount: number }>();
  const payments: Payment[] = [];
  const refunds = new Map<string, { id: string; payment_id: string; amount: number }>();
  let seq = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      // ---- control endpoints used by tests ----
      if (url.pathname === '/__pay' && req.method === 'POST') {
        const order = orders.get(body.orderId);
        if (!order) return send(404, { error: 'unknown order' });
        const p: Payment = {
          id: `pay_e2e${++seq}`,
          order_id: order.id,
          status: body.status ?? 'captured',
          amount: body.amount ?? order.amount,
        };
        payments.push(p);
        return send(200, p);
      }
      if (url.pathname === '/__state') {
        return send(200, {
          orders: [...orders.values()],
          payments,
          refunds: [...refunds.values()],
        });
      }

      // ---- the Razorpay API subset the app uses ----
      if (!String(req.headers.authorization ?? '').startsWith('Basic '))
        return send(401, { error: 'unauthorised' });
      const path = url.pathname.replace(/^\/v1/, '');
      if (req.method === 'POST' && path === '/orders') {
        const id = `order_e2e${++seq}`;
        orders.set(id, { id, amount: body.amount });
        return send(200, { id });
      }
      const list = path.match(/^\/orders\/([^/]+)\/payments$/);
      if (req.method === 'GET' && list)
        return send(200, { items: payments.filter((p) => p.order_id === list[1]) });
      const refund = path.match(/^\/payments\/([^/]+)\/refund$/);
      if (req.method === 'POST' && refund) {
        const key = String(req.headers['x-refund-idempotency'] ?? '');
        if (key && refunds.has(key)) return send(200, { id: refunds.get(key)!.id });
        const id = `rfnd_e2e${++seq}`;
        refunds.set(key || id, { id, payment_id: refund[1]!, amount: body.amount });
        return send(200, { id });
      }
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

export const fakeRzp = (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${FAKE_RZP_PORT}${path}`, init);

/** A webhook request exactly as Razorpay would send it, signed with the app's webhook secret. */
export function signedWebhook(
  event: 'payment.captured' | 'payment.failed',
  p: { id: string; order_id: string; amount: number },
  eventId: string,
  secret = WEBHOOK_SECRET,
) {
  const body = JSON.stringify({ entity: 'event', event, payload: { payment: { entity: p } } });
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-event-id': eventId,
      'x-razorpay-signature': createHmac('sha256', secret).update(body).digest('hex'),
    },
  };
}

export function returnSignature(orderId: string, paymentId: string, secret = KEY_SECRET) {
  return createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}
