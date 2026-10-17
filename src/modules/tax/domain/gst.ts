/**
 * GST maths (SPEC §4.3, ADR 0005). Pure integer arithmetic on paise; no floats.
 *
 * Prices are tax-INCLUSIVE, so tax is extracted from the line total:
 *   tax = round_half_up(gross * rate / (10000 + rate))     (rate in basis points)
 * It is computed once per line, after discounts, on the line total (never per unit), and the order's tax
 * is the sum of its lines. Intra-state supplies split into CGST + SGST (the odd paisa goes to SGST),
 * inter-state supplies carry IGST.
 */
export type TaxRule =
  | { kind: 'fixed'; rateBp: number }
  | { kind: 'slab'; rateBp: number; thresholdPaise: number; rateBpAbove: number };

/** Rate (basis points) applying to one unit at `unitPaise`. A missing rule means no tax. */
export function rateForUnit(rule: TaxRule | null | undefined, unitPaise: number): number {
  if (!rule) return 0;
  if (rule.kind === 'fixed') return rule.rateBp;
  // Slab rates are decided by the unit price: up to and including the threshold, or above it.
  return unitPaise <= rule.thresholdPaise ? rule.rateBp : rule.rateBpAbove;
}

/** Tax contained in a tax-inclusive amount, rounded half up. Exact for any safe-integer amount. */
export function extractTax(grossPaise: number, rateBp: number): number {
  if (!Number.isSafeInteger(grossPaise) || grossPaise < 0)
    throw new RangeError('gross must be a non-negative integer');
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10_000)
    throw new RangeError('rate must be 0..10000 bp');
  if (rateBp === 0 || grossPaise === 0) return 0;
  const num = BigInt(grossPaise) * BigInt(rateBp);
  const den = BigInt(10_000 + rateBp);
  // floor((2*num + den) / (2*den)) is round-half-up of num/den.
  return Number((2n * num + den) / (2n * den));
}

export type GstSplit = { cgstPaise: number; sgstPaise: number; igstPaise: number };

export function splitGst(taxPaise: number, intraState: boolean): GstSplit {
  if (!Number.isSafeInteger(taxPaise) || taxPaise < 0)
    throw new RangeError('tax must be a non-negative integer');
  if (!intraState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise };
  const cgstPaise = Math.floor(taxPaise / 2);
  return { cgstPaise, sgstPaise: taxPaise - cgstPaise, igstPaise: 0 };
}

export type LineTax = GstSplit & { rateBp: number; taxPaise: number; basePaise: number };

/** All tax figures for one line from its tax-inclusive total (after discount). */
export function computeLineTax(
  rule: TaxRule | null | undefined,
  unitPaise: number,
  lineTotalPaise: number,
  intraState: boolean,
): LineTax {
  const rateBp = rateForUnit(rule, unitPaise);
  const taxPaise = extractTax(lineTotalPaise, rateBp);
  return {
    rateBp,
    taxPaise,
    basePaise: lineTotalPaise - taxPaise,
    ...splitGst(taxPaise, intraState),
  };
}
