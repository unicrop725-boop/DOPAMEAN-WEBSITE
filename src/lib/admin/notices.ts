/**
 * One-line success banners shown after an action that navigates (the URL carries a key, never free text,
 * so nobody can craft a link that shows a misleading message).
 */
export const NOTICES = {
  'order-shipped': 'Order marked as shipped. The customer was emailed the tracking details.',
  'order-delivered': 'Order marked as delivered and completed.',
  'order-cancelled': 'Order cancelled. Stock was returned and any payment is being refunded.',
  'order-refunded': 'Refund recorded.',
  'order-cod-collected': 'Cash collection recorded.',
  'order-note': 'Note added to the order timeline.',
  'product-created': 'Product created as a draft. Add images, then publish it.',
  'product-deleted': 'Product deleted.',
  'product-archived':
    'This product was on past orders, so it was archived and hidden instead of deleted.',
  'staff-created': 'Staff account created.',
  'settings-saved': 'Settings saved.',
  'tax-rule-created': 'Tax rule added.',
  'content-saved': 'Page saved.',
} as const;

export type NoticeKey = keyof typeof NOTICES;

export function noticeHref(path: string, key: NoticeKey): string {
  return `${path}${path.includes('?') ? '&' : '?'}notice=${key}`;
}

export function noticeText(key: string | string[] | undefined): string | null {
  const k = Array.isArray(key) ? key[0] : key;
  return k && Object.hasOwn(NOTICES, k) ? NOTICES[k as NoticeKey] : null;
}
