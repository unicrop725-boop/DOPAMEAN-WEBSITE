import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  NormalizedProviderEvent,
  PaymentProvider,
  ProviderPayment,
  ProviderPaymentStatus,
} from './provider';

/**
 * Razorpay adapter (TEST mode keys until the owner supplies live ones).
 * NOT VERIFIED against the live Razorpay API: no credentials were available when this was written. The
 * signature maths follows Razorpay's documentation and is unit tested; the HTTP calls are not.
 * Requires auto-capture to be enabled on the Razorpay account.
 */
const API = 'https://api.razorpay.com/v1';

export type RazorpayConfig = { keyId: string; keySecret: string; webhookSecret: string };

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createRazorpayProvider(
  cfg: RazorpayConfig,
  fetchImpl: typeof fetch = fetch,
): PaymentProvider {
  const auth = `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<T> {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`razorpay ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  return {
    name: 'razorpay',
    publicKeyId: cfg.keyId,

    async createOrder({ amountPaise, receipt, notes }) {
      const o = await call<{ id: string }>('POST', '/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt: receipt.slice(0, 40),
        notes,
      });
      return { providerOrderId: o.id };
    },

    async listOrderPayments(providerOrderId) {
      const r = await call<{ items: { id: string; status: string; amount: number }[] }>(
        'GET',
        `/orders/${encodeURIComponent(providerOrderId)}/payments`,
      );
      return r.items.map((p): ProviderPayment => ({
        providerPaymentId: p.id,
        status: (['created', 'authorized', 'captured', 'failed', 'refunded'].includes(p.status)
          ? p.status
          : 'failed') as ProviderPaymentStatus,
        amountPaise: p.amount,
      }));
    },

    async refund({ providerPaymentId, amountPaise, idempotencyKey, notes }) {
      const r = await call<{ id: string }>(
        'POST',
        `/payments/${encodeURIComponent(providerPaymentId)}/refund`,
        { amount: amountPaise, notes },
        { 'X-Refund-Idempotency': idempotencyKey },
      );
      return { providerRefundId: r.id };
    },

    verifyWebhookSignature(rawBody, signature) {
      if (!signature) return false;
      return safeEqualHex(hmacHex(cfg.webhookSecret, rawBody), signature);
    },

    verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature }) {
      return safeEqualHex(
        hmacHex(cfg.keySecret, `${providerOrderId}|${providerPaymentId}`),
        signature,
      );
    },

    parseWebhook(rawBody, headers) {
      let body: {
        event?: string;
        payload?: {
          payment?: { entity?: { id?: string; order_id?: string; amount?: number } };
          refund?: { entity?: { id?: string; payment_id?: string; amount?: number } };
        };
      };
      try {
        body = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const eventId = headers.get('x-razorpay-event-id');
      if (!eventId || !body.event) return null;
      const pay = body.payload?.payment?.entity;
      const refund = body.payload?.refund?.entity;
      const base = {
        eventId,
        providerOrderId: pay?.order_id,
        providerPaymentId: pay?.id ?? refund?.payment_id,
      };
      switch (body.event) {
        case 'payment.captured':
        case 'order.paid':
          return {
            ...base,
            type: 'payment.captured',
            amountPaise: pay?.amount,
          } satisfies NormalizedProviderEvent;
        case 'payment.failed':
          return {
            ...base,
            type: 'payment.failed',
            amountPaise: pay?.amount,
          } satisfies NormalizedProviderEvent;
        case 'refund.processed':
          return {
            ...base,
            type: 'refund.processed',
            amountPaise: refund?.amount,
            providerRefundId: refund?.id,
          } satisfies NormalizedProviderEvent;
        default:
          return { ...base, type: 'other' } satisfies NormalizedProviderEvent;
      }
    },
  };
}

/** Provider from environment, or null when Razorpay is not configured (online payment is then unavailable). */
export function razorpayFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentProvider | null {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = env;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !RAZORPAY_WEBHOOK_SECRET) return null;
  return createRazorpayProvider({
    keyId: RAZORPAY_KEY_ID,
    keySecret: RAZORPAY_KEY_SECRET,
    webhookSecret: RAZORPAY_WEBHOOK_SECRET,
  });
}
