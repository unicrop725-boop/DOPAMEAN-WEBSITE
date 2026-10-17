'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { getDb } from '@/db/client';
import { ensureCartOwner } from '@/lib/cart-owner';
import { getCheckoutDeps } from '@/lib/checkout-deps';
import { describeChanges } from '@/lib/checkout-messages';
import { AppError } from '@/lib/errors';
import { baseLogger } from '@/lib/logger';
import { hitRateLimit } from '@/lib/rate-limit';
import { getSessionUser } from '@/lib/session';
import { getAddress } from '@/modules/customers';
import { placeOrder } from '@/modules/checkout';
import type { QuoteChange } from '@/modules/pricing';

export type PlaceState = {
  ok: boolean;
  code?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Present for PRICE_CHANGED / STOCK_CHANGED: what the customer must re-confirm. */
  changes?: string[];
  /** What the customer typed, echoed back: React resets uncontrolled fields after every action. */
  values?: Record<string, string>;
};

const ECHOED_FIELDS = [
  'email',
  'phone',
  'fullName',
  'line1',
  'line2',
  'city',
  'stateCode',
  'pincode',
  'addressPhone',
] as const;

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 1 ? String(issue.path[1]) : String(issue.path[0] ?? 'form');
    out[key] ??= issue.message;
  }
  return out;
}

/**
 * Place the order. Everything that matters (prices, totals, tax, stock, shipping) is recomputed on the
 * server; the form only carries WHAT the customer wants plus the signed token of what they were shown.
 */
export async function placeOrderAction(prev: PlaceState, form: FormData): Promise<PlaceState> {
  const result = await placeOrderInner(prev, form);
  if (result.ok) return result;
  const values: Record<string, string> = {};
  for (const k of ECHOED_FIELDS) values[k] = String(form.get(k) ?? '');
  return { ...result, values };
}

async function placeOrderInner(_prev: PlaceState, form: FormData): Promise<PlaceState> {
  const text = (k: string) => String(form.get(k) ?? '');
  const method = text('paymentMethod') === 'online' ? 'online' : 'cod';
  const user = await getSessionUser();

  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const limit = await hitRateLimit(getDb(), `checkout:${ip}`, 10, 10 * 60);
  if (!limit.allowed)
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: 'Too many attempts. Please wait a few minutes and try again.',
    };

  // A saved address is loaded by id AND owner (INV-13): someone else's id simply finds nothing.
  let address = {
    fullName: text('fullName'),
    line1: text('line1'),
    line2: text('line2'),
    city: text('city'),
    stateCode: text('stateCode'),
    pincode: text('pincode'),
    phone: text('addressPhone') || text('phone'),
  };
  const savedId = text('addressId');
  if (user && savedId) {
    const saved = await getAddress(getDb(), user.id, savedId);
    if (!saved)
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: 'That saved address could not be found.',
      };
    address = {
      fullName: saved.fullName,
      line1: saved.line1,
      line2: saved.line2 ?? '',
      city: saved.city,
      stateCode: saved.stateCode,
      pincode: saved.pincode,
      phone: saved.phone,
    };
  }

  let target: string;
  try {
    const deps = await getCheckoutDeps();
    const owner = await ensureCartOwner();
    const result = await placeOrder(deps, owner, user?.id ?? null, {
      email: text('email'),
      phone: text('phone'),
      address,
      paymentMethod: method,
      idempotencyKey: text('idempotencyKey'),
      quoteToken: text(method === 'online' ? 'quoteTokenOnline' : 'quoteTokenCod'),
    });
    const base = user
      ? `/account/orders/${result.order.publicId}`
      : `/orders/${result.order.publicId}?t=${result.accessToken}`;
    target =
      method === 'online' && result.order.status === 'pending_payment'
        ? `/checkout/pay/${result.order.publicId}?t=${result.accessToken}`
        : base;
  } catch (err) {
    if (err instanceof ZodError)
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        fieldErrors: fieldErrorsOf(err),
        message: 'Please check the highlighted fields.',
      };
    if (err instanceof AppError) {
      if (err.code === 'CART_EMPTY') redirect('/cart');
      if (err.code === 'PRICE_CHANGED' || err.code === 'STOCK_CHANGED') {
        const changes = (err.details as { changes?: QuoteChange[] } | undefined)?.changes ?? [];
        return {
          ok: false,
          code: err.code,
          message: 'Your order changed while you were checking out. Nothing was charged.',
          changes: describeChanges(changes),
        };
      }
      const message: Record<string, string> = {
        OUT_OF_STOCK: 'An item in your bag just sold out. Nothing was charged.',
        PRODUCT_UNAVAILABLE: 'An item in your bag is no longer available.',
        COD_NOT_AVAILABLE: 'Cash on delivery is not available right now.',
        COD_LIMIT_EXCEEDED: 'This order is above the cash on delivery limit. Please pay online.',
        PAYMENT_FAILED: 'We could not start the payment. Please try again.',
        VALIDATION_FAILED: err.message,
      };
      return {
        ok: false,
        code: err.code,
        message: message[err.code] ?? 'We could not place your order.',
      };
    }
    baseLogger.error({ err }, 'placeOrder failed');
    return {
      ok: false,
      code: 'INTERNAL',
      message: 'Something went wrong. Nothing was charged. Please try again.',
    };
  }
  redirect(target);
}
