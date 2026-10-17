import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { clearCart, type CartOwner } from '@/modules/cart';
import { addressInput, indianMobile } from '@/modules/customers';
import { commitReservations, reserveStock } from '@/modules/inventory';
import { enqueueEmail, orderPlacedEmail } from '@/modules/notifications';
import {
  findOrderByIdempotencyKey,
  insertOrder,
  recordOrderEvent,
  transitionOrderRow,
  type OrderRow,
} from '@/modules/orders';
import {
  attachProviderOrder,
  createPayment,
  getPaymentByOrderId,
  type PaymentRow,
} from '@/modules/payments';
import { diffSnapshots, snapshotOf, verifyQuoteToken, type PaymentMethod } from '@/modules/pricing';
import { cancelOrderFlow } from './lifecycle';
import { deriveAccessToken, nowOf, orderUrl, rupees, type CheckoutDeps } from './context';
import { quoteCart } from './quote';

export const placeOrderInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  phone: indianMobile,
  address: addressInput.omit({ isDefault: true }),
  paymentMethod: z.enum(['online', 'cod']),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/, 'invalid idempotency key'),
  quoteToken: z.string().min(1).max(20_000),
});
export type PlaceOrderInput = z.input<typeof placeOrderInput>;

export type PlaceOrderResult = {
  order: OrderRow;
  payment: PaymentRow;
  /** True when this idempotency key had already produced an order (INV-06). */
  replay: boolean;
  /** Present for online orders: the provider order the browser must pay. */
  providerOrderId: string | null;
  accessToken: string;
};

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const code = e.cause?.code ?? e.code;
  const name = e.cause?.constraint ?? e.constraint;
  return code === '23505' && (name?.includes(constraint) ?? false);
}

async function replayOf(deps: CheckoutDeps, key: string): Promise<PlaceOrderResult | null> {
  const existing = await findOrderByIdempotencyKey(deps.db, key);
  if (!existing) return null;
  const payment = await getPaymentByOrderId(deps.db, existing.id);
  if (!payment) throw new Error('order without payment');
  return {
    order: existing,
    payment,
    replay: true,
    providerOrderId: payment.providerOrderId,
    accessToken: deriveAccessToken(deps.secret, key),
  };
}

/**
 * Place an order. The amount charged is computed here from database prices, tax, shipping and stock; the
 * browser only sends WHAT it wants plus the signed token of what it was shown (INV-01, INV-12).
 *
 *  1. Replay: the same idempotency key returns the same order, never a second one (INV-06).
 *  2. Recompute the quote; if anything the customer saw has changed, stop and say what (INV-12).
 *  3. One transaction: order + line snapshots (INV-07) + stock reservation (INV-03) + payment row.
 *     COD orders are confirmed and the stock sold immediately; online orders wait for a verified
 *     payment while the stock is held (INV-10).
 *  4. Online only, after commit: create the provider order for the server-computed amount.
 */
export async function placeOrder(
  deps: CheckoutDeps,
  owner: CartOwner,
  customerId: string | null,
  rawInput: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const input = placeOrderInput.parse(rawInput);
  const replay = await replayOf(deps, input.idempotencyKey);
  if (replay) return replay;

  if (input.paymentMethod === 'online' && !deps.provider) {
    throw new AppError('PAYMENT_FAILED', 'online payment is not available right now');
  }

  const cq = await quoteCart(deps.db, deps.secret, owner, {
    destinationStateCode: input.address.stateCode,
    paymentMethod: input.paymentMethod as PaymentMethod,
  });
  const quote = cq.quote;
  // Items that are no longer sold take priority over "empty": the customer must be told why they vanished.
  if (cq.removedVariantIds.length > 0) {
    throw new AppError('PRODUCT_UNAVAILABLE', 'some items are no longer available', {
      variantIds: cq.removedVariantIds,
    });
  }
  if (quote.lines.length === 0) throw new AppError('CART_EMPTY');

  const seen = verifyQuoteToken(deps.secret, input.quoteToken);
  if (!seen)
    throw new AppError(
      'VALIDATION_FAILED',
      'checkout session is invalid, please review your order again',
    );
  const changes = diffSnapshots(seen, snapshotOf(quote));
  if (changes.length > 0) {
    const money = changes.some(
      (c) =>
        c.kind === 'price' || c.kind === 'total' || c.kind === 'shipping' || c.kind === 'discount',
    );
    throw new AppError(
      money ? 'PRICE_CHANGED' : 'STOCK_CHANGED',
      'your order changed, please review it',
      { changes },
    );
  }

  const stockIssue = quote.issues.find((i) => i.code === 'OUT_OF_STOCK');
  if (stockIssue)
    throw new AppError('OUT_OF_STOCK', 'an item is out of stock', { issues: quote.issues });
  const codIssue = quote.issues.find(
    (i) => i.code === 'COD_NOT_AVAILABLE' || i.code === 'COD_LIMIT_EXCEEDED',
  );
  if (codIssue)
    throw new AppError(codIssue.code, 'cash on delivery is not available for this order', {
      issue: codIssue,
    });

  const now = nowOf(deps);
  const accessToken = deriveAccessToken(deps.secret, input.idempotencyKey);
  const reserveUntil = new Date(now.getTime() + deps.reservationTtlMinutes * 60_000);
  const deadline =
    input.paymentMethod === 'online'
      ? new Date(now.getTime() + deps.paymentDeadlineMinutes * 60_000)
      : null;

  let placed: { order: OrderRow; payment: PaymentRow };
  try {
    placed = await deps.db.transaction(async (tx) => {
      const order = await insertOrder(tx, {
        customerId,
        email: input.email,
        phone: input.phone,
        paymentMethod: input.paymentMethod,
        shippingAddress: { ...input.address, phone: input.address.phone },
        idempotencyKey: input.idempotencyKey,
        accessToken,
        subtotalPaise: quote.subtotalPaise,
        discountPaise: quote.discountPaise,
        shippingPaise: quote.shippingPaise,
        codFeePaise: quote.codFeePaise,
        taxPaise: quote.taxPaise,
        totalPaise: quote.totalPaise,
        paymentDeadlineAt: deadline,
        lines: quote.lines.map((l) => ({
          variantId: l.variantId,
          productId: l.productId,
          productName: l.name,
          optionLabel: l.optionLabel,
          optionValues: l.optionValues,
          sku: l.sku,
          imageKey: l.imageKey,
          hsnCode: l.hsnCode,
          unitPaise: l.unitPaise,
          qty: l.qty,
          discountPaise: l.discountPaise,
          totalPaise: l.totalPaise,
          taxRateBp: l.rateBp,
          taxPaise: l.taxPaise,
          cgstPaise: l.cgstPaise,
          sgstPaise: l.sgstPaise,
          igstPaise: l.igstPaise,
        })),
      });

      // INV-03: throws OUT_OF_STOCK (rolling back the order too) if any line is short.
      await reserveStock(tx, {
        refId: order.id,
        items: quote.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
        expiresAt: reserveUntil,
      });

      const payment = await createPayment(tx, {
        orderId: order.id,
        method: input.paymentMethod,
        amountPaise: quote.totalPaise,
        provider: input.paymentMethod === 'online' ? deps.provider!.name : undefined,
      });

      let current = order;
      if (input.paymentMethod === 'cod') {
        // Cash on delivery: accepted now, stock sold now, cash collected later by staff.
        await commitReservations(tx, order.id);
        const { order: confirmed } = await transitionOrderRow(tx, order.id, 'confirm', 'system', {
          payload: { via: 'cod' },
        });
        current = confirmed;
      }

      await clearCart(tx, owner);
      await enqueueEmail(
        tx,
        orderPlacedEmail({
          to: current.email,
          customerName: input.address.fullName,
          orderNumber: current.number,
          totalLabel: rupees(current.totalPaise),
          paymentMethod: current.paymentMethod,
          orderUrl: orderUrl(deps, current),
          lines: quote.lines.map((l) => ({
            name: l.name,
            option: l.optionLabel,
            qty: l.qty,
            totalLabel: rupees(l.totalPaise),
          })),
        }),
      );
      return { order: current, payment };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'order_idempotency_uq')) {
      // Two identical submissions raced: the other one won. Return its order.
      const raced = await replayOf(deps, input.idempotencyKey);
      if (raced) return raced;
    }
    throw err;
  }

  if (input.paymentMethod === 'cod') {
    return { ...placed, replay: false, providerOrderId: null, accessToken };
  }

  // Online: create the provider order for the server-computed amount (never a client-sent one).
  try {
    const { providerOrderId } = await deps.provider!.createOrder({
      amountPaise: placed.order.totalPaise,
      receipt: `order-${placed.order.number}`,
      notes: { orderId: placed.order.publicId },
    });
    await attachProviderOrder(deps.db, placed.payment.id, deps.provider!.name, providerOrderId);
    return { ...placed, replay: false, providerOrderId, accessToken };
  } catch (err) {
    // The provider could not create the order: release the stock and cancel instead of leaving a dead order.
    await cancelOrderFlow(deps, placed.order.id, {
      actor: 'system',
      actorId: 'system',
      reason: 'payment_provider_unavailable',
    }).catch(() => undefined);
    await recordOrderEvent(deps.db, placed.order.id, 'payment.provider_error', 'system', {
      message: err instanceof Error ? err.message.slice(0, 300) : 'error',
    }).catch(() => undefined);
    throw new AppError('PAYMENT_FAILED', 'we could not start the payment, please try again');
  }
}
