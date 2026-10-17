import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRazorpayProvider, razorpayFromEnv } from '@/modules/payments';

const cfg = {
  keyId: 'rzp_test_abc',
  keySecret: 'key_secret_value',
  webhookSecret: 'webhook_secret_value',
};
const provider = createRazorpayProvider(
  cfg,
  (async () => new Response('{}')) as unknown as typeof fetch,
);
const hex = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

describe('Razorpay signatures (HMAC-SHA256)', () => {
  it('verifies the webhook signature over the exact raw body', () => {
    const body = '{"event":"payment.captured"}';
    expect(provider.verifyWebhookSignature(body, hex(cfg.webhookSecret, body))).toBe(true);
  });

  it('rejects a missing, wrong, truncated or body-edited signature', () => {
    const body = '{"event":"payment.captured"}';
    const good = hex(cfg.webhookSecret, body);
    expect(provider.verifyWebhookSignature(body, null)).toBe(false);
    expect(provider.verifyWebhookSignature(body, '')).toBe(false);
    expect(provider.verifyWebhookSignature(body, good.slice(0, -1))).toBe(false);
    expect(provider.verifyWebhookSignature(body, hex('other-secret', body))).toBe(false);
    expect(provider.verifyWebhookSignature(`${body} `, good)).toBe(false); // a re-serialised body would not match
  });

  it('verifies the checkout return signature over order_id|payment_id with the KEY secret', () => {
    const sig = hex(cfg.keySecret, 'order_1|pay_1');
    expect(
      provider.verifyCheckoutSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        signature: sig,
      }),
    ).toBe(true);
    expect(
      provider.verifyCheckoutSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_2',
        signature: sig,
      }),
    ).toBe(false);
    expect(
      provider.verifyCheckoutSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        signature: hex(cfg.webhookSecret, 'order_1|pay_1'),
      }),
    ).toBe(false);
  });
});

describe('Razorpay webhook parsing', () => {
  const headers = (id?: string) => new Headers(id ? { 'x-razorpay-event-id': id } : {});

  it('normalises captured, failed and refund events', () => {
    const payment = { entity: { id: 'pay_1', order_id: 'order_1', amount: 149900 } };
    expect(
      provider.parseWebhook(
        JSON.stringify({ event: 'payment.captured', payload: { payment } }),
        headers('e1'),
      ),
    ).toEqual({
      eventId: 'e1',
      type: 'payment.captured',
      providerOrderId: 'order_1',
      providerPaymentId: 'pay_1',
      amountPaise: 149900,
    });
    expect(
      provider.parseWebhook(
        JSON.stringify({ event: 'payment.failed', payload: { payment } }),
        headers('e2'),
      )?.type,
    ).toBe('payment.failed');
    const refund = provider.parseWebhook(
      JSON.stringify({
        event: 'refund.processed',
        payload: {
          payment,
          refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 5000 } },
        },
      }),
      headers('e3'),
    );
    expect(refund).toMatchObject({
      type: 'refund.processed',
      providerRefundId: 'rfnd_1',
      amountPaise: 5000,
    });
  });

  it('treats order.paid like a capture and unknown events as "other"', () => {
    const payment = { entity: { id: 'pay_1', order_id: 'order_1', amount: 100 } };
    expect(
      provider.parseWebhook(
        JSON.stringify({ event: 'order.paid', payload: { payment } }),
        headers('e'),
      )?.type,
    ).toBe('payment.captured');
    expect(
      provider.parseWebhook(JSON.stringify({ event: 'something.else', payload: {} }), headers('e'))
        ?.type,
    ).toBe('other');
  });

  it('returns null for bad JSON, a missing event id or a missing event name', () => {
    expect(provider.parseWebhook('not json', headers('e'))).toBeNull();
    expect(
      provider.parseWebhook(JSON.stringify({ event: 'payment.captured' }), headers()),
    ).toBeNull();
    expect(provider.parseWebhook(JSON.stringify({ payload: {} }), headers('e'))).toBeNull();
  });
});

describe('configuration', () => {
  it('is null (online payment disabled) unless all three Razorpay values are set', () => {
    expect(razorpayFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      razorpayFromEnv({
        RAZORPAY_KEY_ID: 'a',
        RAZORPAY_KEY_SECRET: 'b',
      } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      razorpayFromEnv({
        RAZORPAY_KEY_ID: 'a',
        RAZORPAY_KEY_SECRET: 'b',
        RAZORPAY_WEBHOOK_SECRET: 'c',
      } as unknown as NodeJS.ProcessEnv)?.name,
    ).toBe('razorpay');
  });
});
