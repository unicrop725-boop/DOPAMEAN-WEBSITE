import { getSettings, toPricingSettings, type StoreSettings } from '@/lib/settings';
import { getCartLines, type CartOwner } from '@/modules/cart';
import { getPurchasableVariants } from '@/modules/catalog';
import { loadTaxRules } from '@/modules/tax';
import {
  priceCart,
  signQuote,
  type PaymentMethod,
  type Quote,
  type QuoteLineInput,
} from '@/modules/pricing';
import type { DbOrTx } from '@/db/client';

export type CartQuote = {
  quote: Quote;
  /** Signed snapshot of exactly what the customer is shown (INV-12). */
  token: string;
  /** Cart lines whose product is no longer sold (unpublished, deleted, variant inactive). */
  removedVariantIds: string[];
  settings: StoreSettings;
};

/**
 * Price the owner's cart from database values only (INV-01). Quantities come from the cart, everything
 * else (price, tax, stock, shipping rules) from the catalog, inventory and settings.
 */
export async function quoteCart(
  db: DbOrTx,
  secret: string,
  owner: CartOwner,
  opts: { destinationStateCode?: string; paymentMethod: PaymentMethod },
): Promise<CartQuote> {
  const cartLines = await getCartLines(db, owner);
  const variants = await getPurchasableVariants(
    db,
    cartLines.map((l) => l.variantId),
  );
  const rules = await loadTaxRules(
    db,
    [...variants.values()].map((v) => v.taxRuleId).filter((x): x is string => !!x),
  );
  const settings = await getSettings(db);

  const lines: QuoteLineInput[] = [];
  const removedVariantIds: string[] = [];
  for (const l of cartLines) {
    const v = variants.get(l.variantId);
    if (!v) {
      removedVariantIds.push(l.variantId);
      continue;
    }
    lines.push({
      variantId: v.variantId,
      productId: v.productId,
      sku: v.sku,
      name: v.productName,
      optionLabel: v.optionLabel,
      optionValues: v.optionValues,
      hsnCode: v.hsnCode,
      imageKey: v.imageKey,
      unitPaise: v.pricePaise,
      qty: l.qty,
      available: v.available,
      taxRule: v.taxRuleId ? (rules.get(v.taxRuleId) ?? null) : null,
    });
  }

  const quote = priceCart({
    lines,
    destinationStateCode: opts.destinationStateCode ?? settings.sellerStateCode,
    paymentMethod: opts.paymentMethod,
    settings: toPricingSettings(settings),
  });
  return { quote, token: signQuote(secret, quote), removedVariantIds, settings };
}
