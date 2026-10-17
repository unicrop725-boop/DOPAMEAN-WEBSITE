/**
 * Payment provider boundary. The rest of the system only ever talks to this interface, never to a provider
 * SDK. Card data never touches our servers: the customer pays in the provider's hosted checkout (brief §7).
 */
export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';

export type ProviderPayment = {
  providerPaymentId: string;
  status: ProviderPaymentStatus;
  amountPaise: number;
};

export type NormalizedProviderEvent = {
  /** Unique per provider notification: used to drop redeliveries (INV-04). */
  eventId: string;
  type: 'payment.captured' | 'payment.failed' | 'refund.processed' | 'other';
  providerOrderId?: string;
  providerPaymentId?: string;
  amountPaise?: number;
  providerRefundId?: string;
};

export interface PaymentProvider {
  readonly name: string;
  /** Public key the browser needs to open the hosted checkout. */
  readonly publicKeyId: string;
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<{ providerOrderId: string }>;
  listOrderPayments(providerOrderId: string): Promise<ProviderPayment[]>;
  refund(input: {
    providerPaymentId: string;
    amountPaise: number;
    idempotencyKey: string;
    notes?: Record<string, string>;
  }): Promise<{ providerRefundId: string }>;
  /** Signature check on the RAW request body (never a re-serialised copy). */
  verifyWebhookSignature(rawBody: string, signature: string | null): boolean;
  /** Signature the browser returns after paying (`order_id|payment_id`). */
  verifyCheckoutSignature(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): boolean;
  parseWebhook(rawBody: string, headers: Headers): NormalizedProviderEvent | null;
}
