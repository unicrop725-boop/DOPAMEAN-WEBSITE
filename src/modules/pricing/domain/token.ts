import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Quote } from './quote';

/**
 * Pricing token (INV-01 / INV-12). When the checkout page is rendered the server signs exactly what it
 * showed the customer. On "place order" the server recomputes the quote from the database and compares:
 * if anything the customer saw changed (price, stock, shipping, total) checkout stops and shows the
 * difference. The client can echo the token but cannot forge or edit it (HMAC), and its totals are never
 * used to charge anything.
 */
export type QuoteSnapshot = {
  method: Quote['paymentMethod'];
  state: string;
  lines: {
    variantId: string;
    name: string;
    optionLabel: string;
    qty: number;
    unitPaise: number;
    inStock: boolean;
  }[];
  shippingPaise: number;
  discountPaise: number;
  totalPaise: number;
};

export function snapshotOf(q: Quote): QuoteSnapshot {
  return {
    method: q.paymentMethod,
    state: q.destinationStateCode,
    lines: q.lines
      .map((l) => ({
        variantId: l.variantId,
        name: l.name,
        optionLabel: l.optionLabel,
        qty: l.qty,
        unitPaise: l.unitPaise,
        inStock: l.available >= l.qty,
      }))
      .sort((a, b) => a.variantId.localeCompare(b.variantId)),
    shippingPaise: q.shippingPaise,
    discountPaise: q.discountPaise,
    totalPaise: q.totalPaise,
  };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (secret: string, body: string) =>
  createHmac('sha256', secret).update(body).digest('base64url');

export function signQuote(secret: string, q: Quote): string {
  const body = b64(JSON.stringify(snapshotOf(q)));
  return `${body}.${sign(secret, body)}`;
}

/** Returns the snapshot the customer saw, or null when the token is missing, malformed or forged. */
export function verifyQuoteToken(
  secret: string,
  token: string | undefined | null,
): QuoteSnapshot | null {
  if (!token) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as QuoteSnapshot;
  } catch {
    return null;
  }
}

export type QuoteChange =
  | { kind: 'price'; variantId: string; name: string; oldPaise: number; newPaise: number }
  | { kind: 'stock'; variantId: string; name: string }
  | { kind: 'removed'; variantId: string; name: string }
  | { kind: 'added'; variantId: string; name: string }
  | { kind: 'quantity'; variantId: string; name: string; oldQty: number; newQty: number }
  | { kind: 'shipping'; oldPaise: number; newPaise: number }
  | { kind: 'discount'; oldPaise: number; newPaise: number }
  | { kind: 'total'; oldPaise: number; newPaise: number };

/** What changed between what the customer saw and what the server computes now. Empty means identical. */
export function diffSnapshots(seen: QuoteSnapshot, now: QuoteSnapshot): QuoteChange[] {
  const changes: QuoteChange[] = [];
  const before = new Map(seen.lines.map((l) => [l.variantId, l]));
  const after = new Map(now.lines.map((l) => [l.variantId, l]));
  for (const [id, o] of before) {
    const n = after.get(id);
    if (!n) changes.push({ kind: 'removed', variantId: id, name: o.name });
    else {
      if (n.unitPaise !== o.unitPaise)
        changes.push({
          kind: 'price',
          variantId: id,
          name: n.name,
          oldPaise: o.unitPaise,
          newPaise: n.unitPaise,
        });
      if (n.qty !== o.qty)
        changes.push({
          kind: 'quantity',
          variantId: id,
          name: n.name,
          oldQty: o.qty,
          newQty: n.qty,
        });
      if (n.inStock !== o.inStock) changes.push({ kind: 'stock', variantId: id, name: n.name });
    }
  }
  for (const [id, n] of after)
    if (!before.has(id)) changes.push({ kind: 'added', variantId: id, name: n.name });
  if (seen.shippingPaise !== now.shippingPaise)
    changes.push({ kind: 'shipping', oldPaise: seen.shippingPaise, newPaise: now.shippingPaise });
  if (seen.discountPaise !== now.discountPaise)
    changes.push({ kind: 'discount', oldPaise: seen.discountPaise, newPaise: now.discountPaise });
  if (
    seen.totalPaise !== now.totalPaise ||
    seen.method !== now.method ||
    seen.state !== now.state
  ) {
    if (seen.totalPaise !== now.totalPaise)
      changes.push({ kind: 'total', oldPaise: seen.totalPaise, newPaise: now.totalPaise });
  }
  return changes;
}
