import { Money } from './money';
import { computeLineTax, extractTax, type TaxRule } from '@/modules/tax';

/**
 * The single place where an order total is computed (INV-01). Pure TypeScript: inputs are database
 * values, never anything the browser sent. Prices are tax-inclusive paise.
 */
export type PaymentMethod = 'online' | 'cod';

export type QuoteLineInput = {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  /** e.g. "Size: XL" */
  optionLabel: string;
  optionValues: Record<string, string>;
  hsnCode: string | null;
  imageKey: string | null;
  unitPaise: number;
  qty: number;
  /** Units that can be sold right now (on hand minus reserved). */
  available: number;
  taxRule: TaxRule | null;
};

export type PricingSettings = {
  /** GST state code of the seller, e.g. "06". Decides CGST+SGST vs IGST. */
  sellerStateCode: string;
  shippingFlatPaise: number;
  /** Subtotal (after discount) at or above which shipping is free. 0 means shipping is always free. */
  freeShippingThresholdPaise: number;
  codEnabled: boolean;
  codMaxPaise: number;
  codFeePaise: number;
};

export type QuoteLine = QuoteLineInput & {
  grossPaise: number;
  discountPaise: number;
  /** Tax-inclusive line total after discount: what the customer pays for this line. */
  totalPaise: number;
  rateBp: number;
  taxPaise: number;
  basePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
};

export type QuoteIssue =
  | { code: 'OUT_OF_STOCK'; variantId: string; available: number; requested: number }
  | { code: 'COD_NOT_AVAILABLE' }
  | { code: 'COD_LIMIT_EXCEEDED'; maxPaise: number };

export type Quote = {
  lines: QuoteLine[];
  paymentMethod: PaymentMethod;
  destinationStateCode: string;
  intraState: boolean;
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  shippingTaxPaise: number;
  codFeePaise: number;
  taxPaise: number;
  totalPaise: number;
  issues: QuoteIssue[];
};

export function priceCart(input: {
  lines: QuoteLineInput[];
  destinationStateCode: string;
  paymentMethod: PaymentMethod;
  settings: PricingSettings;
  /** Total discount in paise (coupons), spread across lines proportionally. Never more than the subtotal. */
  discountPaise?: number;
}): Quote {
  const { settings, destinationStateCode, paymentMethod } = input;
  const intraState = destinationStateCode === settings.sellerStateCode;
  const grosses = input.lines.map((l) => Money.of(l.unitPaise).times(l.qty));
  const subtotal = grosses.reduce((a, b) => a.add(b), Money.zero());
  const discount = Money.min(Money.of(input.discountPaise ?? 0), subtotal);
  const shares =
    discount.isZero() || subtotal.isZero()
      ? grosses.map(() => Money.zero())
      : discount.allocate(grosses.map((g) => g.paise));

  const lines: QuoteLine[] = input.lines.map((l, i) => {
    const gross = grosses[i]!;
    const lineDiscount = Money.min(shares[i]!, gross);
    const total = gross.sub(lineDiscount);
    const tax = computeLineTax(l.taxRule, l.unitPaise, total.paise, intraState);
    return {
      ...l,
      grossPaise: gross.paise,
      discountPaise: lineDiscount.paise,
      totalPaise: total.paise,
      rateBp: tax.rateBp,
      taxPaise: tax.taxPaise,
      basePaise: tax.basePaise,
      cgstPaise: tax.cgstPaise,
      sgstPaise: tax.sgstPaise,
      igstPaise: tax.igstPaise,
    };
  });

  const afterDiscount = subtotal.sub(discount);
  const shipping =
    lines.length === 0 || afterDiscount.paise >= settings.freeShippingThresholdPaise
      ? Money.zero()
      : Money.of(settings.shippingFlatPaise);
  // Shipping is taxed at the highest rate in the cart (composite supply principal rate).
  const shippingRate = lines.reduce((m, l) => Math.max(m, l.rateBp), 0);
  const shippingTax = extractTax(shipping.paise, shippingRate);
  const codFee = paymentMethod === 'cod' ? Money.of(settings.codFeePaise) : Money.zero();
  const codFeeTax = extractTax(codFee.paise, shippingRate);

  const total = afterDiscount.add(shipping).add(codFee);
  const taxPaise = lines.reduce((s, l) => s + l.taxPaise, 0) + shippingTax + codFeeTax;

  const issues: QuoteIssue[] = [];
  for (const l of lines) {
    if (l.available < l.qty) {
      issues.push({
        code: 'OUT_OF_STOCK',
        variantId: l.variantId,
        available: Math.max(0, l.available),
        requested: l.qty,
      });
    }
  }
  if (paymentMethod === 'cod') {
    if (!settings.codEnabled) issues.push({ code: 'COD_NOT_AVAILABLE' });
    else if (total.paise > settings.codMaxPaise)
      issues.push({ code: 'COD_LIMIT_EXCEEDED', maxPaise: settings.codMaxPaise });
  }

  return {
    lines,
    paymentMethod,
    destinationStateCode,
    intraState,
    subtotalPaise: subtotal.paise,
    discountPaise: discount.paise,
    shippingPaise: shipping.paise,
    shippingTaxPaise: shippingTax + codFeeTax,
    codFeePaise: codFee.paise,
    taxPaise,
    totalPaise: total.paise,
    issues,
  };
}
