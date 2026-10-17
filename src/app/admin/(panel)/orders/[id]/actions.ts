'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { runAction, type ActionState } from '@/lib/action-result';
import {
  addOrderNote,
  cancelOrderAdmin,
  collectCodAdmin,
  deliverOrderAdmin,
  refundOrderAdmin,
  shipOrderAdmin,
} from '@/lib/admin/orders';
import { noticeHref, type NoticeKey } from '@/lib/admin/notices';
import { getCheckoutDeps } from '@/lib/checkout-deps';
import { AppError } from '@/lib/errors';
import { parseRupees } from '@/lib/rupees';
import { resolveStaffFor } from '@/lib/staff-context';

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** Run an order action, then land back on the order with a one-line confirmation. */
async function finish(
  orderId: string,
  notice: NoticeKey,
  result: ActionState,
): Promise<ActionState> {
  if (!result.ok) return result;
  const path = `/admin/orders/${orderId}`;
  revalidatePath(path);
  revalidatePath('/admin/orders');
  redirect(noticeHref(path, notice));
}

export async function shipAction(
  orderId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('orders.ship');
    await shipOrderAdmin(await getCheckoutDeps(), admin, orderId, {
      carrier: text(form, 'carrier'),
      trackingNo: text(form, 'trackingNo'),
      trackingUrl: text(form, 'trackingUrl') || undefined,
    });
  }, form);
  return finish(orderId, 'order-shipped', result);
}

export async function deliverAction(orderId: string): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('orders.ship');
    await deliverOrderAdmin(await getCheckoutDeps(), admin, orderId);
  });
  return finish(orderId, 'order-delivered', result);
}

export async function collectCodAction(orderId: string): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('orders.ship');
    await collectCodAdmin(await getCheckoutDeps(), admin, orderId);
  });
  return finish(orderId, 'order-cod-collected', result);
}

export async function cancelAction(
  orderId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('orders.cancel');
    await cancelOrderAdmin(await getCheckoutDeps(), admin, orderId, {
      reason: text(form, 'reason'),
    });
  }, form);
  return finish(orderId, 'order-cancelled', result);
}

export async function refundAction(
  orderId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('orders.refund');
    const amountPaise = parseRupees(text(form, 'amount'));
    if (amountPaise === null) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Enter the amount in rupees, for example 499 or 499.50.',
        {
          fieldErrors: { amount: 'Enter the amount in rupees, for example 499 or 499.50' },
        },
      );
    }
    await refundOrderAdmin(await getCheckoutDeps(), admin, orderId, {
      amountPaise,
      reason: text(form, 'reason'),
      idempotencyKey: text(form, 'idempotencyKey') || randomUUID(),
    });
  }, form);
  return finish(orderId, 'order-refunded', result);
}

export async function noteAction(
  orderId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('orders.note');
    await addOrderNote(getDb(), admin, orderId, { text: text(form, 'text') });
    return 'Note added.';
  }, form);
  if (result.ok) revalidatePath(`/admin/orders/${orderId}`);
  return result;
}
