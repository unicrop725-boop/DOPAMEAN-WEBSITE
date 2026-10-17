import 'server-only';
import { buildCheckoutDeps } from '@/lib/checkout-deps-core';
import type { CheckoutDeps } from '@/modules/checkout';

/** Checkout wiring for pages, route handlers and server actions (see checkout-deps-core.ts). */
export function getCheckoutDeps(): Promise<CheckoutDeps> {
  return buildCheckoutDeps();
}
